import { invoke } from "@tauri-apps/api/core";
import type {
  DiffFile,
  FileDiff,
  TerminalTab,
} from "../types";
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
import type {
  CommitEntry,
  DiffLayer,
  StagedDiffFiles,
} from "../types/diff";

export * from "./tauri/apps";
export * from "./tauri/auth";
export * from "./tauri/debug";
export * from "./tauri/initialData";
export * from "./tauri/metrics";
export * from "./tauri/notifications";
export * from "./tauri/settings";
export * from "./tauri/shell";
export * from "./tauri/updater";
export * from "./tauri/usage";
export * from "./tauri/worktrees";
export * from "./tauri/workspace";
export * from "./tauri/repository";
export * from "./tauri/plan";
export * from "./tauri/chatSessions";
export * from "./tauri/checkpoints";
export * from "./tauri/remoteControl";
export * from "./tauri/chat";
export * from "./tauri/fileMentions";
export * from "./tauri/pinnedPrompts";
export * from "./tauri/slashCommands";

// -- Agent Backends --

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

import type { PluginInfo, ScmDetail, PullRequest } from "../types/plugin";

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
