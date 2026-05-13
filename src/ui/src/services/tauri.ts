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
import type { WorkspaceEnvTrustNeededPayload } from "../types/env";

export * from "./tauri/apps";
export * from "./tauri/auth";
export * from "./tauri/debug";
export * from "./tauri/metrics";
export * from "./tauri/notifications";
export * from "./tauri/settings";
export * from "./tauri/shell";
export * from "./tauri/updater";
export * from "./tauri/usage";

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

export type AgentBackendKind =
  | "anthropic"
  | "ollama"
  | "openai_api"
  | "codex_subscription"
  | "custom_anthropic"
  | "custom_openai"
  | "lm_studio";

export interface AgentBackendCapabilities {
  thinking: boolean;
  effort: boolean;
  fast_mode: boolean;
  one_m_context: boolean;
  tools: boolean;
  vision: boolean;
}

export interface AgentBackendModel {
  id: string;
  label: string;
  context_window_tokens: number;
  discovered: boolean;
}

export interface AgentBackendConfig {
  id: string;
  label: string;
  kind: AgentBackendKind;
  base_url: string | null;
  enabled: boolean;
  default_model: string | null;
  manual_models: AgentBackendModel[];
  discovered_models: AgentBackendModel[];
  auth_ref: string | null;
  capabilities: AgentBackendCapabilities;
  context_window_default: number;
  model_discovery: boolean;
  has_secret: boolean;
}

export interface AgentBackendListResponse {
  backends: AgentBackendConfig[];
  default_backend_id: string;
  /**
   * Non-fatal diagnostics from the tolerant loader — e.g. a stored
   * backend entry whose `kind` isn't recognized by this build. The
   * entries are preserved in SQLite (so they round-trip through
   * downgrades), but the user should know they aren't active.
   * Omitted from the wire payload (i.e. `undefined` here) when
   * everything parsed cleanly — the Rust side uses
   * `skip_serializing_if = "Vec::is_empty"`, so consumers should
   * treat `undefined` and `[]` identically.
   */
  warnings?: string[];
}

export interface BackendSecretUpdate {
  backend_id: string;
  value: string | null;
}

export interface BackendStatus {
  ok: boolean;
  message: string;
  backends?: AgentBackendConfig[];
}

export function loadInitialData(): Promise<InitialData> {
  return invoke("load_initial_data");
}

export function listAgentBackends(): Promise<AgentBackendListResponse> {
  return invoke("list_agent_backends");
}

export function saveAgentBackend(
  backend: AgentBackendConfig,
): Promise<AgentBackendConfig[]> {
  return invoke("save_agent_backend", { backend });
}

export function deleteAgentBackend(
  backendId: string,
): Promise<AgentBackendConfig[]> {
  return invoke("delete_agent_backend", { backendId });
}

export function saveAgentBackendSecret(
  update: BackendSecretUpdate,
): Promise<void> {
  return invoke("save_agent_backend_secret", { update });
}

export function refreshAgentBackendModels(
  backendId: string,
): Promise<AgentBackendConfig[]> {
  return invoke("refresh_agent_backend_models", { backendId });
}

export function testAgentBackend(backendId: string): Promise<BackendStatus> {
  return invoke("test_agent_backend", { backendId });
}

export function launchCodexLogin(): Promise<void> {
  return invoke("launch_codex_login");
}

// -- Repository --

export function addRepository(path: string): Promise<Repository> {
  return invoke("add_repository", { path });
}

export function initRepository(parentPath: string, name: string): Promise<Repository> {
  return invoke("init_repository", { parentPath, name });
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

/**
 * Tri-state toggle override on a pinned prompt:
 * - `null` means "inherit the session's current toolbar value when used"
 * - `true` / `false` forces the toolbar toggle to that value (sticky write)
 */
export type PinnedPromptToggleOverride = boolean | null;

export interface PinnedPrompt {
  id: number;
  repo_id: string | null;
  display_name: string;
  prompt: string;
  auto_send: boolean;
  plan_mode: PinnedPromptToggleOverride;
  fast_mode: PinnedPromptToggleOverride;
  thinking_enabled: PinnedPromptToggleOverride;
  chrome_enabled: PinnedPromptToggleOverride;
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

export interface PinnedPromptToggleOverrides {
  planMode: PinnedPromptToggleOverride;
  fastMode: PinnedPromptToggleOverride;
  thinkingEnabled: PinnedPromptToggleOverride;
  chromeEnabled: PinnedPromptToggleOverride;
}

export function createPinnedPrompt(
  repoId: string | null,
  displayName: string,
  prompt: string,
  autoSend: boolean,
  overrides: PinnedPromptToggleOverrides,
): Promise<PinnedPrompt> {
  return invoke("create_pinned_prompt", {
    repoId,
    displayName,
    prompt,
    autoSend,
    planMode: overrides.planMode,
    fastMode: overrides.fastMode,
    thinkingEnabled: overrides.thinkingEnabled,
    chromeEnabled: overrides.chromeEnabled,
  });
}

export function updatePinnedPrompt(
  id: number,
  displayName: string,
  prompt: string,
  autoSend: boolean,
  overrides: PinnedPromptToggleOverrides,
): Promise<PinnedPrompt> {
  return invoke("update_pinned_prompt", {
    id,
    displayName,
    prompt,
    autoSend,
    planMode: overrides.planMode,
    fastMode: overrides.fastMode,
    thinkingEnabled: overrides.thinkingEnabled,
    chromeEnabled: overrides.chromeEnabled,
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
  backendId?: string,
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
    backendId: backendId ?? null,
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

export type ClaudeRemoteControlLifecycle =
  | "disabled"
  | "enabling"
  | "ready"
  | "connected"
  | "reconnecting"
  | "error";

export interface ClaudeRemoteControlStatus {
  state: ClaudeRemoteControlLifecycle;
  sessionUrl: string | null;
  connectUrl: string | null;
  environmentId: string | null;
  detail: string | null;
  lastError: string | null;
}

export function getClaudeRemoteControlStatus(
  chatSessionId: string,
): Promise<ClaudeRemoteControlStatus> {
  return invoke("get_claude_remote_control_status", { chatSessionId });
}

export function setClaudeRemoteControl(
  chatSessionId: string,
  enabled: boolean,
  options: {
    permissionLevel?: string;
    model?: string;
    fastMode?: boolean;
    thinkingEnabled?: boolean;
    planMode?: boolean;
    effort?: string | null;
    chromeEnabled?: boolean;
    disable1mContext?: boolean;
    backendId?: string;
  } = {},
): Promise<ClaudeRemoteControlStatus> {
  return invoke("set_claude_remote_control", {
    chatSessionId,
    enabled,
    permissionLevel: options.permissionLevel ?? null,
    model: options.model ?? null,
    fastMode: options.fastMode ?? null,
    thinkingEnabled: options.thinkingEnabled ?? null,
    planMode: options.planMode ?? null,
    effort: options.effort ?? null,
    chromeEnabled: options.chromeEnabled ?? null,
    disable1mContext: options.disable1mContext ?? null,
    backendId: options.backendId ?? null,
  });
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

export function setSessionCliInvocation(
  chatSessionId: string,
  invocation: string,
): Promise<void> {
  return invoke("set_session_cli_invocation", {
    chatSessionId,
    invocation,
  });
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
 * Restore a previously archived chat session — flips status back to active
 * and clears `archived_at` so the session reappears in the workspace's
 * tab list. The frontend should add the returned row back to the store.
 */
export function restoreChatSession(
  sessionId: string,
): Promise<ChatSession> {
  return invoke("restore_chat_session", { sessionId });
}

/**
 * Archive a chat session. By default, when this was the workspace's last
 * active session, the backend auto-creates a fresh "New chat" replacement
 * and returns it (so the frontend can select the new tab). Pass
 * `autoReplace: false` to opt out — the workspace becomes session-less and
 * the frontend can render its empty-tabs view. Returns the auto-created
 * session in the auto-replace path; `null` otherwise.
 */
export function archiveChatSession(
  sessionId: string,
  autoReplace: boolean = true,
): Promise<ChatSession | null> {
  return invoke("archive_chat_session", { sessionId, autoReplace });
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

export function interruptPtyForeground(ptyId: number): Promise<void> {
  return invoke("interrupt_pty_foreground", { ptyId });
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
