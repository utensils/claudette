import { invoke } from "@tauri-apps/api/core";
import type {
  Repository,
  Workspace,
  ChatMessage,
  ChatAttachment,
  ChatHistoryPage,
  AttachmentInput,
  ChatSession,
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
import type {
  AnalyticsMetrics,
  DashboardMetrics,
  WorkspaceMetrics,
} from "../types/metrics";
import type {
  BulkPluginUpdateResult,
  EditablePluginScope,
  InstalledPlugin,
  PluginCatalog,
  PluginConfiguration,
  PluginMarketplace,
} from "../types/plugins";
import type { ConversationCheckpoint } from "../types/checkpoint";
import type {
  CommitEntry,
  DiffLayer,
  FileStatus,
  GitFileLayer,
  StagedDiffFiles,
} from "../types/diff";

// -- Data --

export interface InitialData {
  repositories: Repository[];
  workspaces: Workspace[];
  worktree_base_dir: string;
  default_branches: Record<string, string>;
  last_messages: ChatMessage[];
  scm_cache: ScmStatusCacheRow[];
  manual_workspace_order_repo_ids: string[];
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

// -- Workspace --

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
): Promise<import("../types/repository").SetupResult | null> {
  return invoke("run_workspace_setup", { workspaceId });
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

// -- Worktree Discovery --

export interface DiscoveredWorktree {
  path: string;
  branch_name: string;
  head_sha: string;
  suggested_name: string;
  name_valid: boolean;
}

export function discoverWorktrees(repoId: string): Promise<DiscoveredWorktree[]> {
  return invoke("discover_worktrees", { repoId });
}

export interface WorktreeImport {
  path: string;
  branch_name: string;
  name: string;
}

export function importWorktrees(
  repoId: string,
  imports: WorktreeImport[]
): Promise<Workspace[]> {
  return invoke("import_worktrees", { repoId, imports });
}

// -- Slash Commands --

export type NativeSlashKind = "local_action" | "settings_route" | "prompt_expansion";

export interface SlashCommand {
  name: string;
  description: string;
  source: string;
  /** Alternative names for this canonical command. Empty for file-based entries. */
  aliases?: string[];
  /** Short hint describing expected argument shape, e.g. "[add|remove] <source>". */
  argument_hint?: string | null;
  /** Native command kind. Absent for file-based commands. */
  kind?: NativeSlashKind | null;
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

// -- Pinned Prompts --

export interface PinnedPrompt {
  id: number;
  repo_id: string | null;
  display_name: string;
  prompt: string;
  auto_send: boolean;
  sort_order: number;
  created_at: string;
}

/** Returns the merged composer list: repo entries first, then non-shadowed globals. */
export function getPinnedPrompts(
  repoId: string | null,
): Promise<PinnedPrompt[]> {
  return invoke("get_pinned_prompts", { repoId });
}

/** Returns the prompts in a single scope (null = globals). */
export function listPinnedPromptsInScope(
  repoId: string | null,
): Promise<PinnedPrompt[]> {
  return invoke("list_pinned_prompts_in_scope", { repoId });
}

export function createPinnedPrompt(
  repoId: string | null,
  displayName: string,
  prompt: string,
  autoSend: boolean,
): Promise<PinnedPrompt> {
  return invoke("create_pinned_prompt", {
    repoId,
    displayName,
    prompt,
    autoSend,
  });
}

export function updatePinnedPrompt(
  id: number,
  displayName: string,
  prompt: string,
  autoSend: boolean,
): Promise<PinnedPrompt> {
  return invoke("update_pinned_prompt", {
    id,
    displayName,
    prompt,
    autoSend,
  });
}

export function deletePinnedPrompt(id: number): Promise<void> {
  return invoke("delete_pinned_prompt", { id });
}

export function reorderPinnedPrompts(
  repoId: string | null,
  ids: number[],
): Promise<void> {
  return invoke("reorder_pinned_prompts", { repoId, ids });
}

// -- Plugins --

export function listPlugins(
  repoId?: string,
): Promise<InstalledPlugin[]> {
  return invoke("list_plugins", { repoId: repoId ?? null });
}

export function listPluginCatalog(
  repoId?: string,
): Promise<PluginCatalog> {
  return invoke("list_plugin_catalog", { repoId: repoId ?? null });
}

export function listPluginMarketplaces(
  repoId?: string,
): Promise<PluginMarketplace[]> {
  return invoke("list_plugin_marketplaces", { repoId: repoId ?? null });
}

export function installPlugin(
  target: string,
  scope: EditablePluginScope,
  repoId?: string,
): Promise<string> {
  return invoke("install_plugin", {
    target,
    scope,
    repoId: repoId ?? null,
  });
}

export function uninstallPlugin(
  pluginId: string,
  scope: EditablePluginScope,
  keepData: boolean,
  repoId?: string,
): Promise<string> {
  return invoke("uninstall_plugin", {
    pluginId,
    scope,
    keepData,
    repoId: repoId ?? null,
  });
}

export function enablePlugin(
  pluginId: string,
  scope: EditablePluginScope,
  repoId?: string,
): Promise<string> {
  return invoke("enable_plugin", {
    pluginId,
    scope,
    repoId: repoId ?? null,
  });
}

export function disablePlugin(
  pluginId: string,
  scope: EditablePluginScope,
  repoId?: string,
): Promise<string> {
  return invoke("disable_plugin", {
    pluginId,
    scope,
    repoId: repoId ?? null,
  });
}

export function updatePlugin(
  pluginId: string,
  scope: EditablePluginScope | "managed",
  repoId?: string,
): Promise<string> {
  return invoke("update_plugin", {
    pluginId,
    scope,
    repoId: repoId ?? null,
  });
}

export function updateAllPlugins(
  repoId?: string,
): Promise<BulkPluginUpdateResult> {
  return invoke("update_all_plugins", {
    repoId: repoId ?? null,
  });
}

export function addPluginMarketplace(
  source: string,
  scope: EditablePluginScope,
  repoId?: string,
): Promise<string> {
  return invoke("add_plugin_marketplace", {
    source,
    scope,
    repoId: repoId ?? null,
  });
}

export function removePluginMarketplace(
  name: string,
  repoId?: string,
): Promise<string> {
  return invoke("remove_plugin_marketplace", {
    name,
    repoId: repoId ?? null,
  });
}

export function updatePluginMarketplace(
  name?: string,
  repoId?: string,
): Promise<string> {
  return invoke("update_plugin_marketplace", {
    name: name ?? null,
    repoId: repoId ?? null,
  });
}

export function loadPluginConfiguration(
  pluginId: string,
  repoId?: string,
): Promise<PluginConfiguration> {
  return invoke("load_plugin_configuration", {
    pluginId,
    repoId: repoId ?? null,
  });
}

export function savePluginTopLevelConfiguration(
  pluginId: string,
  values: Record<string, unknown>,
  repoId?: string,
): Promise<void> {
  return invoke("save_plugin_top_level_configuration", {
    pluginId,
    values,
    repoId: repoId ?? null,
  });
}

export function savePluginChannelConfiguration(
  pluginId: string,
  serverName: string,
  values: Record<string, unknown>,
  repoId?: string,
): Promise<void> {
  return invoke("save_plugin_channel_configuration", {
    pluginId,
    serverName,
    values,
    repoId: repoId ?? null,
  });
}

// -- File Mentions --

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

// -- Chat --

export function loadChatHistory(sessionId: string): Promise<ChatMessage[]> {
  return invoke("load_chat_history", { sessionId });
}

export function loadChatHistoryPage(
  sessionId: string,
  limit: number,
  beforeMessageId?: string,
): Promise<ChatHistoryPage> {
  return invoke("load_chat_history_page", {
    sessionId,
    limit,
    beforeMessageId: beforeMessageId ?? null,
  });
}

export function sendChatMessage(
  sessionId: string,
  content: string,
  mentionedFiles?: string[],
  permissionLevel?: string,
  model?: string,
  fastMode?: boolean,
  thinkingEnabled?: boolean,
  planMode?: boolean,
  effort?: string,
  chromeEnabled?: boolean,
  disable1mContext?: boolean,
  attachments?: AttachmentInput[],
  messageId?: string,
): Promise<void> {
  return invoke("send_chat_message", {
    sessionId,
    messageId: messageId ?? null,
    content,
    mentionedFiles: mentionedFiles ?? null,
    permissionLevel: permissionLevel ?? null,
    model: model ?? null,
    fastMode: fastMode ?? null,
    thinkingEnabled: thinkingEnabled ?? null,
    planMode: planMode ?? null,
    effort: effort ?? null,
    chromeEnabled: chromeEnabled ?? null,
    disable1mContext: disable1mContext ?? null,
    attachments: attachments ?? null,
  });
}

export function steerQueuedChatMessage(
  sessionId: string,
  content: string,
  mentionedFiles?: string[],
  attachments?: AttachmentInput[],
  messageId?: string,
): Promise<ConversationCheckpoint | null> {
  return invoke("steer_queued_chat_message", {
    sessionId,
    messageId: messageId ?? null,
    content,
    mentionedFiles: mentionedFiles ?? null,
    attachments: attachments ?? null,
  });
}

export function loadAttachmentsForSession(
  sessionId: string,
): Promise<ChatAttachment[]> {
  return invoke("load_attachments_for_session", { sessionId });
}

export function loadAttachmentData(
  attachmentId: string,
): Promise<string> {
  return invoke("load_attachment_data", { attachmentId });
}

export function readFileAsBase64(path: string): Promise<ChatAttachment> {
  return invoke("read_file_as_base64", { path });
}

export function stopAgent(sessionId: string): Promise<void> {
  return invoke("stop_agent", { sessionId });
}

export function resetAgentSession(sessionId: string): Promise<void> {
  return invoke("reset_agent_session", { sessionId });
}

export function clearAttention(sessionId: string): Promise<void> {
  return invoke("clear_attention", { sessionId });
}

/**
 * Send the user's answers for a pending AskUserQuestion tool_use, keyed by
 * question text. The Rust side layers them onto the tool's original input as
 * `updatedInput.answers` and writes a `control_response` to the CLI.
 */
export function submitAgentAnswer(
  sessionId: string,
  toolUseId: string,
  answers: Record<string, string>,
): Promise<void> {
  return invoke("submit_agent_answer", {
    sessionId,
    toolUseId,
    answers,
    annotations: null,
  });
}

/**
 * Approve or reject a pending ExitPlanMode tool_use. On approve the CLI
 * runs the tool's `call()` and emits the normal "Plan approved" tool_result.
 */
export function submitPlanApproval(
  sessionId: string,
  toolUseId: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  return invoke("submit_plan_approval", {
    sessionId,
    toolUseId,
    approved,
    reason: reason ?? null,
  });
}

// -- Checkpoints --

export function listCheckpoints(
  sessionId: string,
): Promise<ConversationCheckpoint[]> {
  return invoke("list_checkpoints", { sessionId });
}

export function rollbackToCheckpoint(
  sessionId: string,
  checkpointId: string,
  restoreFiles: boolean,
): Promise<ChatMessage[]> {
  return invoke("rollback_to_checkpoint", {
    sessionId,
    checkpointId,
    restoreFiles,
  });
}

export function clearConversation(
  sessionId: string,
  restoreFiles: boolean,
): Promise<ChatMessage[]> {
  return invoke("clear_conversation", {
    sessionId,
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
  sessionId: string,
): Promise<CompletedTurnData[]> {
  return invoke("load_completed_turns", { sessionId });
}

// -- Chat sessions (tabs) --

export function listChatSessions(
  workspaceId: string,
  includeArchived: boolean = false,
): Promise<ChatSession[]> {
  return invoke("list_chat_sessions", { workspaceId, includeArchived });
}

export function getChatSession(sessionId: string): Promise<ChatSession> {
  return invoke("get_chat_session", { sessionId });
}

export function createChatSession(workspaceId: string): Promise<ChatSession> {
  return invoke("create_chat_session", { workspaceId });
}

export function renameChatSession(
  sessionId: string,
  name: string,
): Promise<void> {
  return invoke("rename_chat_session", { sessionId, name });
}

/**
 * Reassign chat-session sort_order to match the supplied id sequence.
 * Used by the unified workspace-tab drag-reorder; only sessions persist —
 * file/diff tabs reorder in volatile frontend state.
 */
export function reorderChatSessions(
  workspaceId: string,
  sessionIds: string[],
): Promise<void> {
  return invoke("reorder_chat_sessions", { workspaceId, sessionIds });
}

/**
 * Archive a chat session. Returns the freshly auto-created session if this
 * was the workspace's last active session (so the frontend can select it),
 * otherwise null.
 */
export function archiveChatSession(
  sessionId: string,
): Promise<ChatSession | null> {
  return invoke("archive_chat_session", { sessionId });
}

// -- Plan --

export function readPlanFile(path: string): Promise<string> {
  return invoke("read_plan_file", { path });
}

// -- Diff --

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

export interface FileContent {
  path: string;
  content: string | null;
  is_binary: boolean;
  size_bytes: number;
  truncated: boolean;
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

export function computeWorkspaceMergeBase(
  workspaceId: string,
): Promise<string> {
  return invoke("compute_workspace_merge_base", { workspaceId });
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

// -- Terminal --

export function createTerminalTab(
  workspaceId: string
): Promise<TerminalTab> {
  return invoke("create_terminal_tab", { workspaceId });
}

export function ensureClaudetteTerminalTab(
  workspaceId: string,
  chatSessionId: string
): Promise<TerminalTab> {
  return invoke("ensure_claudette_terminal_tab", { workspaceId, chatSessionId });
}

export function deleteTerminalTab(id: number): Promise<void> {
  return invoke("delete_terminal_tab", { id });
}

export function listTerminalTabs(
  workspaceId: string
): Promise<TerminalTab[]> {
  return invoke("list_terminal_tabs", { workspaceId });
}

export function updateTerminalTabOrder(
  workspaceId: string,
  tabIds: number[],
): Promise<void> {
  return invoke("update_terminal_tab_order", { workspaceId, tabIds });
}

// -- PTY --

export function spawnPty(
  workingDir: string,
  workspaceName: string,
  workspaceId: string,
  rootPath: string,
  defaultBranch: string,
  branchName: string,
): Promise<number> {
  return invoke("spawn_pty", {
    workingDir,
    workspaceName,
    workspaceId,
    rootPath,
    defaultBranch,
    branchName,
  });
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

export function startAgentTaskTail(
  tabId: number,
  outputPath: string,
): Promise<void> {
  return invoke("start_agent_task_tail", { tabId, outputPath });
}

export function stopAgentTaskTail(tabId: number): Promise<void> {
  return invoke("stop_agent_task_tail", { tabId });
}

export function stopAgentBackgroundTask(
  chatSessionId: string,
  taskId: string,
): Promise<void> {
  return invoke("stop_agent_background_task", {
    chatSessionId,
    taskId,
  });
}

// -- Settings --

export function getAppSetting(key: string): Promise<string | null> {
  return invoke("get_app_setting", { key });
}

export function setAppSetting(key: string, value: string): Promise<void> {
  return invoke("set_app_setting", { key, value });
}

export function deleteAppSetting(key: string): Promise<void> {
  return invoke("delete_app_setting", { key });
}

export function listAppSettingsWithPrefix(prefix: string): Promise<[string, string][]> {
  return invoke("list_app_settings_with_prefix", { prefix });
}

export function getHostEnvFlags(): Promise<{ disable_1m_context: boolean }> {
  return invoke("get_host_env_flags");
}

// -- Updater --

export type UpdateChannel = "stable" | "nightly";

export interface UpdateInfo {
  version: string;
  current_version: string;
  body: string | null;
  date: string | null;
}

export function checkForUpdatesWithChannel(
  channel: UpdateChannel,
): Promise<UpdateInfo | null> {
  return invoke("check_for_updates_with_channel", { channel });
}

export function installPendingUpdate(): Promise<void> {
  return invoke("install_pending_update");
}

import type { ThemeDefinition } from "../types/theme";

export function listUserThemes(): Promise<ThemeDefinition[]> {
  return invoke("list_user_themes");
}

export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}

export function openDevtools(): Promise<void> {
  return invoke("open_devtools");
}

export function getGitUsername(): Promise<string | null> {
  return invoke("get_git_username");
}

export function listNotificationSounds(): Promise<string[]> {
  return invoke("list_notification_sounds");
}

export function listSystemFonts(): Promise<string[]> {
  return invoke("list_system_fonts");
}

export function playNotificationSound(
  sound: string,
  volume?: number,
): Promise<void> {
  return invoke("play_notification_sound", { sound, volume });
}

export function runNotificationCommand(
  workspaceName: string,
  workspaceId: string,
  workspacePath: string,
  rootPath: string,
  defaultBranch: string,
  branchName: string,
): Promise<void> {
  return invoke("run_notification_command", {
    workspaceName,
    workspaceId,
    workspacePath,
    rootPath,
    defaultBranch,
    branchName,
  });
}

// -- Sound Packs (CESP) --

import type { RegistryPack, InstalledSoundPack } from "../types/soundpacks";

export function cespFetchRegistry(): Promise<RegistryPack[]> {
  return invoke("cesp_fetch_registry");
}

export function cespListInstalled(): Promise<InstalledSoundPack[]> {
  return invoke("cesp_list_installed");
}

export function cespInstallPack(
  name: string,
  sourceRepo: string,
  sourceRef: string,
  sourcePath: string,
): Promise<InstalledSoundPack> {
  return invoke("cesp_install_pack", { name, sourceRepo, sourceRef, sourcePath });
}

export function cespUpdatePack(
  name: string,
  sourceRepo: string,
  sourceRef: string,
  sourcePath: string,
): Promise<InstalledSoundPack> {
  return invoke("cesp_update_pack", { name, sourceRepo, sourceRef, sourcePath });
}

export function cespDeletePack(name: string): Promise<void> {
  return invoke("cesp_delete_pack", { name });
}

export function cespPreviewSound(
  packName: string,
  category: string,
): Promise<void> {
  return invoke("cesp_preview_sound", { packName, category });
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

export function openWorkspaceInApp(
  appId: string,
  worktreePath: string,
): Promise<void> {
  return invoke("open_workspace_in_app", {
    appId,
    worktreePath,
  });
}

// -- Usage --

export function getClaudeCodeUsage(): Promise<ClaudeCodeUsage> {
  return invoke("get_claude_code_usage");
}

export function openUsageSettings(): Promise<void> {
  return invoke("open_usage_settings");
}

export function openReleaseNotes(): Promise<void> {
  return invoke("open_release_notes");
}

// -- Auth --

export function claudeAuthLogin(): Promise<void> {
  return invoke("claude_auth_login");
}

export function cancelClaudeAuthLogin(): Promise<void> {
  return invoke("cancel_claude_auth_login");
}

// -- Metrics --

export function getDashboardMetrics(): Promise<DashboardMetrics> {
  return invoke("get_dashboard_metrics");
}

export function getWorkspaceMetricsBatch(
  ids: string[]
): Promise<Record<string, WorkspaceMetrics>> {
  return invoke("get_workspace_metrics_batch", { ids });
}

export function getAnalyticsMetrics(): Promise<AnalyticsMetrics> {
  return invoke("get_analytics_metrics");
}

// -- SCM Plugins --

import type { PluginInfo, ScmDetail, PullRequest, ScmStatusCacheRow } from "../types/plugin";

export function listScmProviders(): Promise<PluginInfo[]> {
  return invoke("list_scm_providers");
}

export function getScmProvider(repoId: string): Promise<string | null> {
  return invoke("get_scm_provider", { repoId });
}

export function setScmProvider(repoId: string, pluginName: string): Promise<void> {
  return invoke("set_scm_provider", { repoId, pluginName });
}

export function loadScmDetail(workspaceId: string): Promise<ScmDetail> {
  return invoke("load_scm_detail", { workspaceId });
}

export function scmCreatePr(
  workspaceId: string,
  title: string,
  body: string,
  base: string,
  draft: boolean
): Promise<PullRequest> {
  return invoke("scm_create_pr", { workspaceId, title, body, base, draft });
}

export function scmMergePr(
  workspaceId: string,
  prNumber: number
): Promise<unknown> {
  return invoke("scm_merge_pr", { workspaceId, prNumber });
}

// -- Debug (dev builds only) --

export function debugEvalJs(js: string): Promise<string> {
  return invoke("debug_eval_js", { js });
}

// Expose invoke on window in dev builds so debug_eval_js can call back.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__CLAUDETTE_INVOKE__ = invoke;
}
