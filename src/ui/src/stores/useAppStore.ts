import { create } from "zustand";
import { DEFAULT_THEME_ID } from "../styles/themes";
import { debugChat } from "../utils/chatDebug";
import { extractLatestCallUsage } from "../utils/extractLatestCallUsage";
import type {
  Repository,
  Workspace,
  ChatMessage,
  ChatAttachment,
  AttachmentInput,
  DiffFile,
  FileDiff,
  DiffViewMode,
  TerminalTab,
  WorkspaceCommandState,
  RemoteConnectionInfo,
  DiscoveredServer,
  ConversationCheckpoint,
} from "../types";
import type { McpStatusSnapshot } from "../types/mcp";
import type { RemoteInitialData } from "../types/remote";
import type { DetectedApp } from "../types/apps";
import type { ClaudeCodeUsage } from "../types/usage";
import type {
  AnalyticsMetrics,
  DashboardMetrics,
  WorkspaceMetrics,
} from "../types/metrics";
import {
  getAnalyticsMetrics,
  getDashboardMetrics,
  getWorkspaceMetricsBatch,
} from "../services/tauri";
import type { SlashCommand } from "../services/tauri";
import type {
  PluginSettingsIntent,
  PluginSettingsTab,
} from "../types/plugins";

export type PermissionLevel = "readonly" | "standard" | "full";

export interface ToolActivity {
  toolUseId: string;
  toolName: string;
  inputJson: string;
  resultText: string;
  collapsed: boolean;
  summary: string;
}

export interface CompletedTurn {
  id: string;
  activities: ToolActivity[];
  messageCount: number;
  collapsed: boolean;
  /** Index into chatMessages at the time of finalization — used to render
   *  the turn summary at the correct chronological position. */
  afterMessageIndex: number;
  /** Commit hash from the corresponding conversation checkpoint, if any.
   *  Used to gate the "fork workspace at this turn" action. */
  commitHash?: string | null;
  /** Total time this turn took, in milliseconds. Summed from the
   *  duration_ms of assistant messages produced during the turn. */
  durationMs?: number;
  /** Turn-total input tokens. Live turns receive this from the CLI's
   *  `result.usage`; persisted turns are reconstructed by summing the
   *  `input_tokens` of each assistant `ChatMessage` in the turn (see
   *  `reconstructCompletedTurns`). Undefined for legacy turns with no
   *  token metadata on any message. */
  inputTokens?: number;
  /** Turn-total output tokens. Live turns receive this from the CLI's
   *  `result.usage`; persisted turns are reconstructed by summing the
   *  `output_tokens` of each assistant `ChatMessage` in the turn. */
  outputTokens?: number;
  /** Turn-total cache-read tokens. Live turns receive this from the CLI's
   *  `result.usage.cache_read_input_tokens`. Persisted turns use the MAX
   *  (not sum) of per-message `cache_read_tokens` — cache counts are
   *  cumulative-per-API-call, so summing across a multi-message tool-use
   *  turn would double-count the shared prompt prefix each call re-reads. */
  cacheReadTokens?: number;
  /** Turn-total cache-creation tokens. Same max-based reconstruction semantics
   *  as `cacheReadTokens`. */
  cacheCreationTokens?: number;
}

export interface AgentQuestionItem {
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface AgentQuestion {
  workspaceId: string;
  toolUseId: string;
  questions: AgentQuestionItem[];
}

export interface PlanApproval {
  workspaceId: string;
  toolUseId: string;
  planFilePath: string | null;
  allowedPrompts: Array<{ tool: string; prompt: string }>;
}

/**
 * Token usage from the most recent completed turn for a workspace.
 * Lives as its own slice (`latestTurnUsage`) rather than being derived from
 * `completedTurns` because `finalizeTurn` early-returns for tool-free turns
 * — so a Q&A turn without tool calls doesn't add a CompletedTurn but should
 * still refresh the ContextMeter. The shape matches the `result.usage` block
 * the CLI emits on every turn end.
 */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

interface AppState {
  // -- Repositories --
  repositories: Repository[];
  setRepositories: (repos: Repository[]) => void;
  addRepository: (repo: Repository) => void;
  updateRepository: (id: string, updates: Partial<Repository>) => void;
  removeRepository: (id: string) => void;

  // -- Workspaces --
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  setWorkspaces: (workspaces: Workspace[]) => void;
  addWorkspace: (ws: Workspace) => void;
  updateWorkspace: (id: string, updates: Partial<Workspace>) => void;
  removeWorkspace: (id: string) => void;
  selectWorkspace: (id: string | null) => void;

  // -- Chat --
  chatMessages: Record<string, ChatMessage[]>;
  chatAttachments: Record<string, ChatAttachment[]>;
  setChatAttachments: (wsId: string, attachments: ChatAttachment[]) => void;
  addChatAttachments: (wsId: string, attachments: ChatAttachment[]) => void;
  streamingContent: Record<string, string>;
  streamingThinking: Record<string, string>;
  pendingTypewriter: Record<string, { messageId: string; text: string } | null>;
  showThinkingBlocks: Record<string, boolean>;
  toolActivities: Record<string, ToolActivity[]>;
  completedTurns: Record<string, CompletedTurn[]>;
  /** Latest `result.usage` values per workspace — kept in sync with every
   *  turn end, including tool-free turns that don't produce a CompletedTurn.
   *  The ContextMeter reads from here so it reflects the latest turn even
   *  when the timeline doesn't record one. */
  latestTurnUsage: Record<string, TurnUsage>;
  setLatestTurnUsage: (wsId: string, usage: TurnUsage) => void;
  /** Delete the meter's usage entry for a workspace. Used when a
   *  rollback or empty load leaves no assistant message with token data —
   *  clearing hides the meter rather than leaving a stale value. */
  clearLatestTurnUsage: (wsId: string) => void;
  setChatMessages: (wsId: string, messages: ChatMessage[]) => void;
  addChatMessage: (wsId: string, message: ChatMessage) => void;
  setStreamingContent: (wsId: string, content: string) => void;
  appendStreamingContent: (wsId: string, text: string) => void;
  setPendingTypewriter: (wsId: string, messageId: string, text: string) => void;
  /** Atomic drain-end handoff: clears both `pendingTypewriter` and
   *  `streamingThinking` in a single store update so the streaming thinking
   *  block and the draining assistant text hand off to the completed message
   *  in the same render, without a gap or a 1-frame duplicate. */
  finishTypewriterDrain: (wsId: string) => void;
  appendStreamingThinking: (wsId: string, text: string) => void;
  clearStreamingThinking: (wsId: string) => void;
  setShowThinkingBlocks: (wsId: string, show: boolean) => void;
  setToolActivities: (wsId: string, activities: ToolActivity[]) => void;
  addToolActivity: (wsId: string, activity: ToolActivity) => void;
  updateToolActivity: (
    wsId: string,
    toolUseId: string,
    updates: Partial<ToolActivity>,
  ) => void;
  toggleToolActivityCollapsed: (wsId: string, index: number) => void;
  finalizeTurn: (
    wsId: string,
    messageCount: number,
    turnId?: string,
    durationMs?: number,
    inputTokens?: number,
    outputTokens?: number,
    cacheReadTokens?: number,
    cacheCreationTokens?: number,
  ) => void;
  hydrateCompletedTurns: (wsId: string, turns: CompletedTurn[]) => void;
  setCompletedTurns: (wsId: string, turns: CompletedTurn[]) => void;
  toggleCompletedTurn: (wsId: string, turnIndex: number) => void;
  appendToolActivityInput: (
    wsId: string,
    toolUseId: string,
    partialJson: string,
  ) => void;

  // -- Agent Questions (per-workspace) --
  agentQuestions: Record<string, AgentQuestion>;
  setAgentQuestion: (q: AgentQuestion) => void;
  clearAgentQuestion: (wsId: string) => void;

  // -- Plan Approvals (per-workspace) --
  planApprovals: Record<string, PlanApproval>;
  setPlanApproval: (p: PlanApproval) => void;
  clearPlanApproval: (wsId: string) => void;

  // -- Queued Messages (sent while agent is running, dispatched when idle) --
  queuedMessages: Record<
    string,
    {
      content: string;
      mentionedFiles?: string[];
      attachments?: AttachmentInput[];
    }
  >;
  setQueuedMessage: (
    wsId: string,
    content: string,
    mentionedFiles?: string[],
    attachments?: AttachmentInput[],
  ) => void;
  clearQueuedMessage: (wsId: string) => void;

  // -- Checkpoints --
  checkpoints: Record<string, ConversationCheckpoint[]>;
  setCheckpoints: (wsId: string, cps: ConversationCheckpoint[]) => void;
  addCheckpoint: (wsId: string, cp: ConversationCheckpoint) => void;
  rollbackConversation: (
    wsId: string,
    checkpointId: string,
    messages: ChatMessage[],
  ) => void;

  // -- Notifications --
  unreadCompletions: Set<string>; // workspace IDs with unread completions
  markWorkspaceAsUnread: (wsId: string) => void;
  clearUnreadCompletion: (wsId: string) => void;

  // -- Permissions --
  permissionLevel: Record<string, PermissionLevel>;
  setPermissionLevel: (wsId: string, level: PermissionLevel) => void;

  // -- Toolbar --
  selectedModel: Record<string, string>;
  fastMode: Record<string, boolean>;
  thinkingEnabled: Record<string, boolean>;
  planMode: Record<string, boolean>;
  effortLevel: Record<string, string>;
  chromeEnabled: Record<string, boolean>;
  modelSelectorOpen: boolean;
  setSelectedModel: (wsId: string, model: string) => void;
  setFastMode: (wsId: string, enabled: boolean) => void;
  setThinkingEnabled: (wsId: string, enabled: boolean) => void;
  setPlanMode: (wsId: string, enabled: boolean) => void;
  setEffortLevel: (wsId: string, level: string) => void;
  setChromeEnabled: (wsId: string, enabled: boolean) => void;
  setModelSelectorOpen: (open: boolean) => void;

  // -- Diff --
  diffFiles: DiffFile[];
  diffMergeBase: string | null;
  diffSelectedFile: string | null;
  diffSelectedLayer: import("../types/diff").DiffLayer | null;
  diffStagedFiles: import("../types/diff").StagedDiffFiles | null;
  diffContent: FileDiff | null;
  diffViewMode: DiffViewMode;
  diffLoading: boolean;
  diffError: string | null;
  setDiffFiles: (files: DiffFile[], mergeBase: string, stagedFiles?: import("../types/diff").StagedDiffFiles | null) => void;
  setDiffSelectedFile: (path: string | null, layer?: import("../types/diff").DiffLayer | null) => void;
  setDiffContent: (content: FileDiff | null) => void;
  setDiffViewMode: (mode: DiffViewMode) => void;
  setDiffLoading: (loading: boolean) => void;
  setDiffError: (error: string | null) => void;
  clearDiff: () => void;

  // -- Terminal --
  terminalTabs: Record<string, TerminalTab[]>;
  // Active tab id is workspace-scoped: switching workspaces preserves each
  // workspace's last-active tab independently.
  activeTerminalTabId: Record<string, number | null>;
  terminalPanelVisible: boolean;
  workspaceTerminalCommands: Record<string, WorkspaceCommandState>;
  setTerminalTabs: (wsId: string, tabs: TerminalTab[]) => void;
  addTerminalTab: (wsId: string, tab: TerminalTab) => void;
  removeTerminalTab: (wsId: string, tabId: number) => void;
  setActiveTerminalTab: (wsId: string, id: number | null) => void;
  toggleTerminalPanel: () => void;
  setWorkspaceTerminalCommand: (
    wsId: string,
    state: WorkspaceCommandState,
  ) => void;
  updateTerminalTabPtyId: (tabId: number, ptyId: number) => void;

  // -- SCM --
  scmSummary: Record<string, import("../types/plugin").ScmSummary>;
  scmDetail: import("../types/plugin").ScmDetail | null;
  scmDetailLoading: boolean;
  setScmSummary: (wsId: string, summary: import("../types/plugin").ScmSummary) => void;
  setScmDetail: (detail: import("../types/plugin").ScmDetail | null) => void;
  setScmDetailLoading: (loading: boolean) => void;

  // -- UI --
  metaKeyHeld: boolean;
  setMetaKeyHeld: (held: boolean) => void;
  sidebarVisible: boolean;
  rightSidebarVisible: boolean;
  sidebarWidth: number;
  rightSidebarWidth: number;
  terminalHeight: number;
  rightSidebarTab: "changes" | "tasks" | "scm";
  sidebarGroupBy: "status" | "repo";
  sidebarRepoFilter: string; // repo ID or "all"
  sidebarShowArchived: boolean;
  repoCollapsed: Record<string, boolean>;
  statusGroupCollapsed: Record<string, boolean>;
  fuzzyFinderOpen: boolean;
  commandPaletteOpen: boolean;
  toggleSidebar: () => void;
  toggleRightSidebar: () => void;
  setRightSidebarTab: (tab: "changes" | "tasks" | "scm") => void;
  setSidebarWidth: (w: number) => void;
  setRightSidebarWidth: (w: number) => void;
  setTerminalHeight: (h: number) => void;
  setSidebarGroupBy: (g: "status" | "repo") => void;
  setSidebarRepoFilter: (id: string) => void;
  setSidebarShowArchived: (show: boolean) => void;
  toggleRepoCollapsed: (id: string) => void;
  toggleStatusGroupCollapsed: (id: string) => void;
  toggleFuzzyFinder: () => void;
  toggleCommandPalette: () => void;

  // -- Settings page --
  settingsOpen: boolean;
  settingsSection: string | null;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
  setSettingsSection: (section: string) => void;
  pluginSettingsTab: PluginSettingsTab;
  pluginSettingsRepoId: string | null;
  pluginSettingsIntent: PluginSettingsIntent | null;
  pluginRefreshToken: number;
  openPluginSettings: (intent?: Partial<PluginSettingsIntent>) => void;
  setPluginSettingsTab: (tab: PluginSettingsTab) => void;
  setPluginSettingsRepoId: (repoId: string | null) => void;
  clearPluginSettingsIntent: () => void;
  bumpPluginRefreshToken: () => void;

  // -- Modals --
  activeModal: string | null;
  modalData: Record<string, unknown>;
  openModal: (name: string, data?: Record<string, unknown>) => void;
  closeModal: () => void;

  // -- Chat input prefill (e.g. after rollback) --
  chatInputPrefill: string | null;
  setChatInputPrefill: (text: string | null) => void;
  pendingAttachmentsPrefill: AttachmentInput[] | null;
  setPendingAttachmentsPrefill: (atts: AttachmentInput[] | null) => void;

  // -- Settings --
  worktreeBaseDir: string;
  setWorktreeBaseDir: (dir: string) => void;
  defaultBranches: Record<string, string>;
  setDefaultBranches: (branches: Record<string, string>) => void;
  terminalFontSize: number;
  setTerminalFontSize: (size: number) => void;
  uiFontSize: number;
  setUiFontSize: (size: number) => void;
  fontFamilySans: string;
  setFontFamilySans: (font: string) => void;
  fontFamilyMono: string;
  setFontFamilyMono: (font: string) => void;
  systemFonts: string[];
  setSystemFonts: (fonts: string[]) => void;
  currentThemeId: string;
  setCurrentThemeId: (id: string) => void;
  lastMessages: Record<string, ChatMessage>;
  setLastMessages: (msgs: Record<string, ChatMessage>) => void;

  // -- Remote Connections --
  remoteConnections: RemoteConnectionInfo[];
  discoveredServers: DiscoveredServer[];
  activeRemoteIds: string[];
  setRemoteConnections: (conns: RemoteConnectionInfo[]) => void;
  addRemoteConnection: (conn: RemoteConnectionInfo) => void;
  removeRemoteConnection: (id: string) => void;
  setDiscoveredServers: (servers: DiscoveredServer[]) => void;
  setActiveRemoteIds: (ids: string[]) => void;
  addActiveRemoteId: (id: string) => void;
  removeActiveRemoteId: (id: string) => void;
  mergeRemoteData: (connectionId: string, data: RemoteInitialData) => void;
  clearRemoteData: (connectionId: string) => void;

  // -- Local Server --
  localServerRunning: boolean;
  localServerConnectionString: string | null;
  setLocalServerRunning: (running: boolean) => void;
  setLocalServerConnectionString: (cs: string | null) => void;

  // -- MCP Status (per-repository) --
  mcpStatus: Record<string, McpStatusSnapshot>;
  setMcpStatus: (repoId: string, snapshot: McpStatusSnapshot) => void;
  clearMcpStatus: (repoId: string) => void;

  // -- Detected Apps --
  detectedApps: DetectedApp[];
  setDetectedApps: (apps: DetectedApp[]) => void;

  // -- Experimental --
  usageInsightsEnabled: boolean;
  setUsageInsightsEnabled: (enabled: boolean) => void;
  pluginManagementEnabled: boolean;
  setPluginManagementEnabled: (enabled: boolean) => void;

  // -- Claude Code Usage --
  claudeCodeUsage: ClaudeCodeUsage | null;
  claudeCodeUsageLoading: boolean;
  claudeCodeUsageError: string | null;
  setClaudeCodeUsage: (usage: ClaudeCodeUsage | null) => void;
  setClaudeCodeUsageLoading: (loading: boolean) => void;
  setClaudeCodeUsageError: (error: string | null) => void;

  // -- Metrics --
  dashboardMetrics: DashboardMetrics | null;
  analyticsMetrics: AnalyticsMetrics | null;
  workspaceMetrics: Record<string, WorkspaceMetrics>;
  metricsError: string | null;
  setDashboardMetrics: (metrics: DashboardMetrics | null) => void;
  setAnalyticsMetrics: (metrics: AnalyticsMetrics | null) => void;
  setWorkspaceMetrics: (metrics: Record<string, WorkspaceMetrics>) => void;
  fetchDashboardMetrics: () => Promise<void>;
  fetchAnalyticsMetrics: () => Promise<void>;
  fetchWorkspaceMetricsBatch: (ids: string[]) => Promise<void>;

  // -- Updater --
  updateAvailable: boolean;
  updateVersion: string | null;
  updateDismissed: boolean;
  updateInstallWhenIdle: boolean;
  updateDownloading: boolean;
  updateProgress: number;
  updateChannel: "stable" | "nightly";
  setUpdateAvailable: (available: boolean, version: string | null) => void;
  setUpdateDismissed: (dismissed: boolean) => void;
  setUpdateInstallWhenIdle: (enabled: boolean) => void;
  setUpdateDownloading: (downloading: boolean) => void;
  setUpdateProgress: (progress: number) => void;
  setUpdateChannel: (channel: "stable" | "nightly") => void;

  // -- App info --
  appVersion: string | null;
  setAppVersion: (version: string | null) => void;

  // -- Slash commands (shared so native dispatch can honor file-based shadows) --
  slashCommandsByWorkspace: Record<string, SlashCommand[]>;
  setSlashCommands: (wsId: string, cmds: SlashCommand[]) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // -- Repositories --
  repositories: [],
  setRepositories: (repos) => set({ repositories: repos }),
  addRepository: (repo) =>
    set((s) => ({ repositories: [...s.repositories, repo] })),
  updateRepository: (id, updates) =>
    set((s) => ({
      repositories: s.repositories.map((r) =>
        r.id === id ? { ...r, ...updates } : r,
      ),
    })),
  removeRepository: (id) =>
    set((s) => {
      const removedWsIds = s.workspaces
        .filter((w) => w.repository_id === id)
        .map((w) => w.id);
      const removedWsIdSet = new Set(removedWsIds);
      const newTerminalTabs = { ...s.terminalTabs };
      const newActiveTerminalTabId = { ...s.activeTerminalTabId };
      const newWorkspaceTerminalCommands = { ...s.workspaceTerminalCommands };
      const newUnreadCompletions = new Set(s.unreadCompletions);
      for (const wsId of removedWsIds) {
        delete newTerminalTabs[wsId];
        delete newActiveTerminalTabId[wsId];
        delete newWorkspaceTerminalCommands[wsId];
        newUnreadCompletions.delete(wsId);
      }
      return {
        repositories: s.repositories.filter((r) => r.id !== id),
        workspaces: s.workspaces.filter((w) => w.repository_id !== id),
        // If the selected workspace belonged to the removed repo, deselect
        // it so the rest of the app doesn't point at a vanished id.
        selectedWorkspaceId:
          s.selectedWorkspaceId && removedWsIdSet.has(s.selectedWorkspaceId)
            ? null
            : s.selectedWorkspaceId,
        terminalTabs: newTerminalTabs,
        activeTerminalTabId: newActiveTerminalTabId,
        workspaceTerminalCommands: newWorkspaceTerminalCommands,
        unreadCompletions: newUnreadCompletions,
      };
    }),

  // -- Workspaces --
  workspaces: [],
  selectedWorkspaceId: null,
  setWorkspaces: (workspaces) => set({ workspaces }),
  addWorkspace: (ws) => set((s) => ({ workspaces: [...s.workspaces, ws] })),
  updateWorkspace: (id, updates) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, ...updates } : w,
      ),
    })),
  removeWorkspace: (id) =>
    set((s) => {
      const newUnreadCompletions = new Set(s.unreadCompletions);
      newUnreadCompletions.delete(id);
      // Drop all per-workspace terminal state for the removed workspace.
      // The cleanup effect in TerminalPanel watches `terminalTabs` and tears
      // down xterm instances and PTYs whose tab ids no longer exist in any
      // workspace; the other maps are value-keyed by workspace id.
      const newTerminalTabs = { ...s.terminalTabs };
      delete newTerminalTabs[id];
      const newActiveTerminalTabId = { ...s.activeTerminalTabId };
      delete newActiveTerminalTabId[id];
      const newWorkspaceTerminalCommands = { ...s.workspaceTerminalCommands };
      delete newWorkspaceTerminalCommands[id];
      return {
        workspaces: s.workspaces.filter((w) => w.id !== id),
        selectedWorkspaceId:
          s.selectedWorkspaceId === id ? null : s.selectedWorkspaceId,
        unreadCompletions: newUnreadCompletions,
        terminalTabs: newTerminalTabs,
        activeTerminalTabId: newActiveTerminalTabId,
        workspaceTerminalCommands: newWorkspaceTerminalCommands,
      };
    }),
  selectWorkspace: (id) =>
    set({ selectedWorkspaceId: id, rightSidebarTab: "changes" }),

  // -- Chat --
  chatMessages: {},
  chatAttachments: {},
  setChatAttachments: (wsId, attachments) =>
    set((s) => ({
      chatAttachments: { ...s.chatAttachments, [wsId]: attachments },
    })),
  addChatAttachments: (wsId, attachments) =>
    set((s) => ({
      chatAttachments: {
        ...s.chatAttachments,
        [wsId]: [...(s.chatAttachments[wsId] ?? []), ...attachments],
      },
    })),
  streamingContent: {},
  streamingThinking: {},
  pendingTypewriter: {},
  showThinkingBlocks: {},
  toolActivities: {},
  completedTurns: {},
  latestTurnUsage: {},
  setLatestTurnUsage: (wsId, usage) =>
    set((s) => ({
      latestTurnUsage: { ...s.latestTurnUsage, [wsId]: usage },
    })),
  clearLatestTurnUsage: (wsId) =>
    set((s) => {
      if (!(wsId in s.latestTurnUsage)) return {};
      const next = { ...s.latestTurnUsage };
      delete next[wsId];
      return { latestTurnUsage: next };
    }),
  setChatMessages: (wsId, messages) =>
    set((s) => ({
      chatMessages: { ...s.chatMessages, [wsId]: messages },
    })),
  addChatMessage: (wsId, message) =>
    set((s) => ({
      chatMessages: {
        ...s.chatMessages,
        [wsId]: [...(s.chatMessages[wsId] || []), message],
      },
      lastMessages: { ...s.lastMessages, [wsId]: message },
    })),
  setStreamingContent: (wsId, content) =>
    set((s) => ({
      streamingContent: { ...s.streamingContent, [wsId]: content },
    })),
  appendStreamingContent: (wsId, text) =>
    set((s) => ({
      streamingContent: {
        ...s.streamingContent,
        [wsId]: (s.streamingContent[wsId] || "") + text,
      },
    })),
  setPendingTypewriter: (wsId, messageId, text) =>
    set((s) => ({
      pendingTypewriter: {
        ...s.pendingTypewriter,
        [wsId]: { messageId, text },
      },
    })),
  finishTypewriterDrain: (wsId) =>
    set((s) => ({
      pendingTypewriter: { ...s.pendingTypewriter, [wsId]: null },
      streamingThinking: { ...s.streamingThinking, [wsId]: "" },
    })),
  appendStreamingThinking: (wsId, text) =>
    set((s) => ({
      streamingThinking: {
        ...s.streamingThinking,
        [wsId]: (s.streamingThinking[wsId] || "") + text,
      },
    })),
  clearStreamingThinking: (wsId) =>
    set((s) => ({
      streamingThinking: { ...s.streamingThinking, [wsId]: "" },
    })),
  setShowThinkingBlocks: (wsId, show) =>
    set((s) => ({
      showThinkingBlocks: { ...s.showThinkingBlocks, [wsId]: show },
    })),
  setToolActivities: (wsId, activities) =>
    set((s) => ({
      toolActivities: { ...s.toolActivities, [wsId]: activities },
    })),
  addToolActivity: (wsId, activity) =>
    set((s) => ({
      toolActivities: {
        ...s.toolActivities,
        [wsId]: [...(s.toolActivities[wsId] || []), activity],
      },
    })),
  updateToolActivity: (wsId, toolUseId, updates) =>
    set((s) => ({
      toolActivities: {
        ...s.toolActivities,
        [wsId]: (s.toolActivities[wsId] || []).map((a) =>
          a.toolUseId === toolUseId ? { ...a, ...updates } : a,
        ),
      },
    })),
  toggleToolActivityCollapsed: (wsId, index) =>
    set((s) => ({
      toolActivities: {
        ...s.toolActivities,
        [wsId]: (s.toolActivities[wsId] || []).map((a, i) =>
          i === index ? { ...a, collapsed: !a.collapsed } : a,
        ),
      },
    })),
  appendToolActivityInput: (wsId, toolUseId, partialJson) =>
    set((s) => ({
      toolActivities: {
        ...s.toolActivities,
        [wsId]: (s.toolActivities[wsId] || []).map((a) =>
          a.toolUseId === toolUseId
            ? { ...a, inputJson: a.inputJson + partialJson }
            : a,
        ),
      },
    })),
  finalizeTurn: (
    wsId,
    messageCount,
    turnId,
    durationMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  ) =>
    set((s) => {
      // Phase 2.5: finalizeTurn no longer writes latestTurnUsage. The
      // meter needs per-call values, not the turn-aggregate we receive
      // here — useAgentStream's result handler calls setLatestTurnUsage
      // separately with the correct per-call data. The tokens we DO
      // receive here stay as CompletedTurn aggregate fields for the
      // TurnFooter's "turn-total work" view.
      const activities = s.toolActivities[wsId] || [];
      if (activities.length === 0) {
        debugChat("store", "finalizeTurn skipped", {
          wsId,
          messageCount,
          turnId: turnId ?? null,
          existingCompletedTurnIds: (s.completedTurns[wsId] || []).map(
            (turn) => turn.id,
          ),
        });
        return {};
      }
      const turn: CompletedTurn = {
        id: turnId ?? crypto.randomUUID(),
        activities: activities.map((a) => ({
          toolUseId: a.toolUseId,
          toolName: a.toolName,
          inputJson: a.inputJson,
          resultText: a.resultText,
          collapsed: true,
          summary: a.summary,
        })),
        messageCount,
        collapsed: true,
        afterMessageIndex: (s.chatMessages[wsId] || []).length,
        durationMs,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      };
      debugChat("store", "finalizeTurn", {
        wsId,
        turnId: turn.id,
        messageCount,
        afterMessageIndex: turn.afterMessageIndex,
        toolCount: turn.activities.length,
        toolUseIds: turn.activities.map((activity) => activity.toolUseId),
        existingCompletedTurnIds: (s.completedTurns[wsId] || []).map(
          (existingTurn) => existingTurn.id,
        ),
      });
      return {
        completedTurns: {
          ...s.completedTurns,
          [wsId]: [...(s.completedTurns[wsId] || []), turn],
        },
        toolActivities: { ...s.toolActivities, [wsId]: [] },
      };
    }),
  hydrateCompletedTurns: (wsId, turns) =>
    set((s) => {
      const existing = s.completedTurns[wsId] || [];
      const existingById = new Map(existing.map((turn) => [turn.id, turn]));
      const incomingIds = new Set(turns.map((turn) => turn.id));

      const merged = turns.map((turn) => {
        const existingTurn = existingById.get(turn.id);
        if (!existingTurn) return turn;

        const existingActivitiesById = new Map(
          existingTurn.activities.map((activity) => [
            activity.toolUseId,
            activity,
          ]),
        );

        return {
          ...turn,
          collapsed: existingTurn.collapsed,
          activities: turn.activities.map((activity) => ({
            ...activity,
            collapsed:
              existingActivitiesById.get(activity.toolUseId)?.collapsed ??
              activity.collapsed,
          })),
        };
      });

      const pendingTurns = existing.filter((turn) => !incomingIds.has(turn.id));
      const nextTurns = [...merged, ...pendingTurns].sort(
        (a, b) => a.afterMessageIndex - b.afterMessageIndex,
      );

      debugChat("store", "hydrateCompletedTurns", {
        wsId,
        existingIds: existing.map((turn) => turn.id),
        incomingIds: turns.map((turn) => turn.id),
        pendingIds: pendingTurns.map((turn) => turn.id),
        nextIds: nextTurns.map((turn) => turn.id),
      });

      return {
        completedTurns: {
          ...s.completedTurns,
          [wsId]: nextTurns,
        },
      };
    }),
  setCompletedTurns: (wsId, turns) =>
    set((s) => {
      debugChat("store", "setCompletedTurns", {
        wsId,
        turnIds: turns.map((turn) => turn.id),
        previousIds: (s.completedTurns[wsId] || []).map((turn) => turn.id),
      });
      return {
        completedTurns: { ...s.completedTurns, [wsId]: turns },
      };
    }),
  toggleCompletedTurn: (wsId, turnIndex) =>
    set((s) => ({
      completedTurns: {
        ...s.completedTurns,
        [wsId]: (s.completedTurns[wsId] || []).map((t, i) =>
          i === turnIndex ? { ...t, collapsed: !t.collapsed } : t,
        ),
      },
    })),

  // -- Agent Questions (per-workspace) --
  agentQuestions: {},
  setAgentQuestion: (q) =>
    set((s) => ({
      agentQuestions: { ...s.agentQuestions, [q.workspaceId]: q },
    })),
  clearAgentQuestion: (wsId) =>
    set((s) => {
      const { [wsId]: _, ...rest } = s.agentQuestions;
      return { agentQuestions: rest };
    }),

  // -- Plan Approvals (per-workspace) --
  planApprovals: {},
  setPlanApproval: (p) =>
    set((s) => ({
      planApprovals: { ...s.planApprovals, [p.workspaceId]: p },
    })),
  clearPlanApproval: (wsId) =>
    set((s) => {
      const { [wsId]: _, ...rest } = s.planApprovals;
      return { planApprovals: rest };
    }),

  // -- Queued Messages --
  queuedMessages: {},
  setQueuedMessage: (wsId, content, mentionedFiles, attachments) =>
    set((s) => ({
      queuedMessages: {
        ...s.queuedMessages,
        [wsId]: { content, mentionedFiles, attachments },
      },
    })),
  clearQueuedMessage: (wsId) =>
    set((s) => {
      const { [wsId]: _, ...rest } = s.queuedMessages;
      return { queuedMessages: rest };
    }),

  // -- Checkpoints --
  checkpoints: {},
  setCheckpoints: (wsId, cps) =>
    set((s) => ({
      checkpoints: { ...s.checkpoints, [wsId]: cps },
    })),
  addCheckpoint: (wsId, cp) =>
    set((s) => ({
      checkpoints: {
        ...s.checkpoints,
        [wsId]: [...(s.checkpoints[wsId] || []), cp],
      },
    })),
  rollbackConversation: (wsId, checkpointId, messages) =>
    set((s) => {
      const { [wsId]: _q, ...restQuestions } = s.agentQuestions;
      const { [wsId]: _p, ...restApprovals } = s.planApprovals;
      // Update lastMessages so workspace preview cards stay in sync.
      const lastMsg =
        messages.length > 0 ? messages[messages.length - 1] : undefined;
      const { [wsId]: _lm, ...restLastMessages } = s.lastMessages;
      const updatedLastMessages = lastMsg
        ? { ...s.lastMessages, [wsId]: lastMsg }
        : restLastMessages;
      // Recompute the meter's latestTurnUsage from the rolled-back message
      // list. Write if the last assistant message has token data; delete
      // the entry otherwise so the meter hides.
      const nextCall = extractLatestCallUsage(messages);
      let latestTurnUsage = s.latestTurnUsage;
      if (nextCall) {
        latestTurnUsage = { ...s.latestTurnUsage, [wsId]: nextCall };
      } else if (wsId in s.latestTurnUsage) {
        const next = { ...s.latestTurnUsage };
        delete next[wsId];
        latestTurnUsage = next;
      }
      return {
        chatMessages: { ...s.chatMessages, [wsId]: messages },
        lastMessages: updatedLastMessages,
        completedTurns: { ...s.completedTurns, [wsId]: [] },
        toolActivities: { ...s.toolActivities, [wsId]: [] },
        streamingContent: { ...s.streamingContent, [wsId]: "" },
        streamingThinking: { ...s.streamingThinking, [wsId]: "" },
        agentQuestions: restQuestions,
        planApprovals: restApprovals,
        checkpoints: {
          ...s.checkpoints,
          [wsId]: (() => {
            const current = s.checkpoints[wsId] || [];
            const target = current.find((c) => c.id === checkpointId);
            // If target not found (e.g. clear-all sentinel), clear everything.
            if (!target) return [];
            return current.filter((cp) => cp.turn_index <= target.turn_index);
          })(),
        },
        latestTurnUsage,
      };
    }),

  // -- Notifications --
  unreadCompletions: new Set<string>(),
  markWorkspaceAsUnread: (wsId) =>
    set((s) => {
      const newSet = new Set(s.unreadCompletions);
      newSet.add(wsId);
      return { unreadCompletions: newSet };
    }),
  clearUnreadCompletion: (wsId) =>
    set((s) => {
      const newSet = new Set(s.unreadCompletions);
      newSet.delete(wsId);
      return { unreadCompletions: newSet };
    }),

  // -- Permissions --
  permissionLevel: {},
  setPermissionLevel: (wsId, level) =>
    set((s) => ({
      permissionLevel: { ...s.permissionLevel, [wsId]: level },
    })),

  // -- Toolbar --
  selectedModel: {},
  fastMode: {},
  thinkingEnabled: {},
  planMode: {},
  effortLevel: {},
  chromeEnabled: {},
  modelSelectorOpen: false,
  setSelectedModel: (wsId, model) =>
    set((s) => ({
      selectedModel: { ...s.selectedModel, [wsId]: model },
    })),
  setFastMode: (wsId, enabled) =>
    set((s) => ({
      fastMode: { ...s.fastMode, [wsId]: enabled },
    })),
  setThinkingEnabled: (wsId, enabled) =>
    set((s) => ({
      thinkingEnabled: { ...s.thinkingEnabled, [wsId]: enabled },
    })),
  setPlanMode: (wsId, enabled) =>
    set((s) => ({
      planMode: { ...s.planMode, [wsId]: enabled },
    })),
  setEffortLevel: (wsId, level) =>
    set((s) => ({
      effortLevel: { ...s.effortLevel, [wsId]: level },
    })),
  setChromeEnabled: (wsId, enabled) =>
    set((s) => ({
      chromeEnabled: { ...s.chromeEnabled, [wsId]: enabled },
    })),
  setModelSelectorOpen: (open) => set({ modelSelectorOpen: open }),

  // -- Diff --
  diffFiles: [],
  diffMergeBase: null,
  diffSelectedFile: null,
  diffSelectedLayer: null,
  diffStagedFiles: null,
  diffContent: null,
  diffViewMode: "Unified",
  diffLoading: false,
  diffError: null,
  setDiffFiles: (files, mergeBase, stagedFiles) =>
    set({ diffFiles: files, diffMergeBase: mergeBase, diffStagedFiles: stagedFiles ?? null }),
  setDiffSelectedFile: (path, layer) => set({ diffSelectedFile: path, diffSelectedLayer: layer ?? null }),
  setDiffContent: (content) => set({ diffContent: content }),
  setDiffViewMode: (mode) => set({ diffViewMode: mode }),
  setDiffLoading: (loading) => set({ diffLoading: loading }),
  setDiffError: (error) => set({ diffError: error }),
  clearDiff: () =>
    set({
      diffFiles: [],
      diffMergeBase: null,
      diffSelectedFile: null,
      diffSelectedLayer: null,
      diffStagedFiles: null,
      diffContent: null,
      diffError: null,
    }),

  // -- SCM --
  scmSummary: {},
  scmDetail: null,
  scmDetailLoading: false,
  setScmSummary: (wsId, summary) =>
    set((s) => ({
      scmSummary: { ...s.scmSummary, [wsId]: summary },
    })),
  setScmDetail: (detail) => set({ scmDetail: detail }),
  setScmDetailLoading: (loading) => set({ scmDetailLoading: loading }),

  // -- Terminal --
  terminalTabs: {},
  activeTerminalTabId: {},
  terminalPanelVisible: false,
  workspaceTerminalCommands: {},
  setTerminalTabs: (wsId, tabs) =>
    set((s) => ({
      terminalTabs: { ...s.terminalTabs, [wsId]: tabs },
    })),
  addTerminalTab: (wsId, tab) =>
    set((s) => ({
      terminalTabs: {
        ...s.terminalTabs,
        [wsId]: [...(s.terminalTabs[wsId] || []), tab],
      },
      activeTerminalTabId: { ...s.activeTerminalTabId, [wsId]: tab.id },
      terminalPanelVisible: true,
    })),
  removeTerminalTab: (wsId, tabId) =>
    set((s) => {
      const tabs = (s.terminalTabs[wsId] || []).filter((t) => t.id !== tabId);
      const wasActive = s.activeTerminalTabId[wsId] === tabId;
      return {
        terminalTabs: { ...s.terminalTabs, [wsId]: tabs },
        activeTerminalTabId: wasActive
          ? { ...s.activeTerminalTabId, [wsId]: tabs[0]?.id ?? null }
          : s.activeTerminalTabId,
      };
    }),
  setActiveTerminalTab: (wsId, id) =>
    set((s) => ({
      activeTerminalTabId: { ...s.activeTerminalTabId, [wsId]: id },
    })),
  toggleTerminalPanel: () =>
    set((s) => ({ terminalPanelVisible: !s.terminalPanelVisible })),
  setWorkspaceTerminalCommand: (wsId, state) =>
    set((s) => ({
      workspaceTerminalCommands: {
        ...s.workspaceTerminalCommands,
        [wsId]: state,
      },
    })),
  updateTerminalTabPtyId: (tabId, ptyId) =>
    set((s) => {
      const newTabs: Record<string, TerminalTab[]> = {};
      for (const [wsId, tabs] of Object.entries(s.terminalTabs)) {
        newTabs[wsId] = tabs.map((tab) =>
          tab.id === tabId ? { ...tab, pty_id: ptyId } : tab,
        );
      }
      return { terminalTabs: newTabs };
    }),

  // -- UI --
  metaKeyHeld: false,
  setMetaKeyHeld: (held) => set({ metaKeyHeld: held }),
  sidebarVisible: true,
  rightSidebarVisible: false,
  sidebarWidth: 260,
  rightSidebarWidth: 250,
  terminalHeight: 300,
  rightSidebarTab: "changes",
  sidebarGroupBy: "repo",
  sidebarRepoFilter: "all",
  sidebarShowArchived: false,
  repoCollapsed: {},
  statusGroupCollapsed: {},
  fuzzyFinderOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  toggleRightSidebar: () =>
    set((s) => ({ rightSidebarVisible: !s.rightSidebarVisible })),
  setRightSidebarTab: (tab) => set({ rightSidebarTab: tab }),
  setSidebarWidth: (w) => set({ sidebarWidth: w }),
  setRightSidebarWidth: (w) => set({ rightSidebarWidth: w }),
  setTerminalHeight: (h) => set({ terminalHeight: h }),
  setSidebarGroupBy: (g) => set({ sidebarGroupBy: g }),
  setSidebarRepoFilter: (id) => set({ sidebarRepoFilter: id }),
  setSidebarShowArchived: (show) => set({ sidebarShowArchived: show }),
  toggleRepoCollapsed: (id) =>
    set((s) => ({
      repoCollapsed: {
        ...s.repoCollapsed,
        [id]: !s.repoCollapsed[id],
      },
    })),
  toggleStatusGroupCollapsed: (id) =>
    set((s) => ({
      statusGroupCollapsed: {
        ...s.statusGroupCollapsed,
        [id]: !s.statusGroupCollapsed[id],
      },
    })),
  toggleFuzzyFinder: () =>
    set((s) => ({ fuzzyFinderOpen: !s.fuzzyFinderOpen })),
  commandPaletteOpen: false,
  toggleCommandPalette: () =>
    set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),

  // -- Settings page --
  settingsOpen: false,
  settingsSection: null,
  openSettings: (section = "general") =>
    set((state) => {
      const nextSection = section === "plugins" && !state.pluginManagementEnabled
        ? "experimental"
        : section;
      return {
        settingsOpen: true,
        settingsSection: nextSection,
        pluginSettingsIntent: nextSection === "plugins" ? null : state.pluginSettingsIntent,
        pluginSettingsRepoId: nextSection === "plugins" ? null : state.pluginSettingsRepoId,
        pluginSettingsTab: nextSection === "plugins" ? "available" : state.pluginSettingsTab,
      };
    }),
  closeSettings: () =>
    set({
      settingsOpen: false,
      settingsSection: null,
      pluginSettingsIntent: null,
      pluginSettingsRepoId: null,
    }),
  setSettingsSection: (section) =>
    set((state) => {
      const nextSection = section === "plugins" && !state.pluginManagementEnabled
        ? "experimental"
        : section;
      return {
        settingsSection: nextSection,
        pluginSettingsIntent: nextSection === "plugins" ? null : state.pluginSettingsIntent,
        pluginSettingsRepoId: nextSection === "plugins" ? null : state.pluginSettingsRepoId,
        pluginSettingsTab: nextSection === "plugins" ? "available" : state.pluginSettingsTab,
      };
    }),
  pluginSettingsTab: "available",
  pluginSettingsRepoId: null,
  pluginSettingsIntent: null,
  pluginRefreshToken: 0,
  openPluginSettings: (intent = {}) =>
    set((state) => {
      if (!state.pluginManagementEnabled) {
        return {};
      }
      const mergedIntent: PluginSettingsIntent = {
        action: intent.action ?? null,
        repoId: intent.repoId ?? null,
        scope: intent.scope ?? "user",
        source: intent.source ?? null,
        tab: intent.tab ?? state.pluginSettingsTab,
        target: intent.target ?? null,
      };
      return {
        settingsOpen: true,
        settingsSection: "plugins",
        pluginSettingsTab: mergedIntent.tab,
        pluginSettingsRepoId: mergedIntent.repoId,
        pluginSettingsIntent: mergedIntent,
      };
    }),
  setPluginSettingsTab: (tab) => set({ pluginSettingsTab: tab }),
  setPluginSettingsRepoId: (repoId) => set({ pluginSettingsRepoId: repoId }),
  clearPluginSettingsIntent: () => set({ pluginSettingsIntent: null }),
  bumpPluginRefreshToken: () =>
    set((state) => ({ pluginRefreshToken: state.pluginRefreshToken + 1 })),

  // -- Modals --
  activeModal: null,
  modalData: {},
  openModal: (name, data = {}) => set({ activeModal: name, modalData: data }),
  closeModal: () => set({ activeModal: null, modalData: {} }),

  // -- Chat input prefill (e.g. after rollback) --
  chatInputPrefill: null,
  setChatInputPrefill: (text) => set({ chatInputPrefill: text }),
  pendingAttachmentsPrefill: null,
  setPendingAttachmentsPrefill: (atts) =>
    set({ pendingAttachmentsPrefill: atts }),

  // -- Settings --
  worktreeBaseDir: "",
  setWorktreeBaseDir: (dir) => set({ worktreeBaseDir: dir }),
  defaultBranches: {},
  setDefaultBranches: (branches) => set({ defaultBranches: branches }),
  terminalFontSize: 11,
  setTerminalFontSize: (size) => set({ terminalFontSize: size }),
  uiFontSize: 13,
  setUiFontSize: (size) => set({ uiFontSize: size }),
  fontFamilySans: "",
  setFontFamilySans: (font) => set({ fontFamilySans: font }),
  fontFamilyMono: "",
  setFontFamilyMono: (font) => set({ fontFamilyMono: font }),
  systemFonts: [],
  setSystemFonts: (fonts) => set({ systemFonts: fonts }),
  currentThemeId: DEFAULT_THEME_ID,
  setCurrentThemeId: (id) => set({ currentThemeId: id }),
  lastMessages: {},
  setLastMessages: (msgs) => set({ lastMessages: msgs }),

  // -- Remote Connections --
  remoteConnections: [],
  discoveredServers: [],
  activeRemoteIds: [],
  setRemoteConnections: (conns) => set({ remoteConnections: conns }),
  addRemoteConnection: (conn) =>
    set((s) => ({ remoteConnections: [...s.remoteConnections, conn] })),
  removeRemoteConnection: (id) =>
    set((s) => ({
      remoteConnections: s.remoteConnections.filter((c) => c.id !== id),
      activeRemoteIds: s.activeRemoteIds.filter((rid) => rid !== id),
    })),
  setDiscoveredServers: (servers) => set({ discoveredServers: servers }),
  setActiveRemoteIds: (ids) => set({ activeRemoteIds: ids }),
  addActiveRemoteId: (id) =>
    set((s) => ({
      activeRemoteIds: s.activeRemoteIds.includes(id)
        ? s.activeRemoteIds
        : [...s.activeRemoteIds, id],
    })),
  removeActiveRemoteId: (id) =>
    set((s) => ({
      activeRemoteIds: s.activeRemoteIds.filter((rid) => rid !== id),
    })),
  mergeRemoteData: (connectionId, data) =>
    set((s) => {
      // Tag remote repos and workspaces with the connection ID, then merge.
      const taggedRepos = data.repositories.map((r) => ({
        ...r,
        remote_connection_id: connectionId,
      }));
      const taggedWorkspaces = data.workspaces.map((w) => ({
        ...w,
        remote_connection_id: connectionId,
      }));
      // Merge remote repo default branches so review-workflow prompts and any
      // other UI keyed off `defaultBranches[repo.id]` work for paired servers.
      // Prune using the repos *previously* stored for this connection so
      // entries for repos removed from the latest payload don't linger.
      const previousRemoteRepoIds = new Set(
        s.repositories
          .filter((r) => r.remote_connection_id === connectionId)
          .map((r) => r.id),
      );
      const prunedDefaults = Object.fromEntries(
        Object.entries(s.defaultBranches).filter(
          ([id]) => !previousRemoteRepoIds.has(id),
        ),
      );
      return {
        repositories: [
          ...s.repositories.filter(
            (r) => r.remote_connection_id !== connectionId,
          ),
          ...taggedRepos,
        ],
        workspaces: [
          ...s.workspaces.filter(
            (w) => w.remote_connection_id !== connectionId,
          ),
          ...taggedWorkspaces,
        ],
        defaultBranches: { ...prunedDefaults, ...data.default_branches },
      };
    }),
  clearRemoteData: (connectionId) =>
    set((s) => {
      const clearedRepoIds = new Set(
        s.repositories
          .filter((r) => r.remote_connection_id === connectionId)
          .map((r) => r.id),
      );
      const prunedDefaults = Object.fromEntries(
        Object.entries(s.defaultBranches).filter(([id]) => !clearedRepoIds.has(id)),
      );
      return {
        repositories: s.repositories.filter(
          (r) => r.remote_connection_id !== connectionId,
        ),
        workspaces: s.workspaces.filter(
          (w) => w.remote_connection_id !== connectionId,
        ),
        defaultBranches: prunedDefaults,
      };
    }),

  // -- Local Server --
  localServerRunning: false,
  localServerConnectionString: null,
  setLocalServerRunning: (running) => set({ localServerRunning: running }),
  setLocalServerConnectionString: (cs) =>
    set({ localServerConnectionString: cs }),

  // -- MCP Status --
  mcpStatus: {},
  setMcpStatus: (repoId, snapshot) =>
    set((state) => ({
      mcpStatus: { ...state.mcpStatus, [repoId]: snapshot },
    })),
  clearMcpStatus: (repoId) =>
    set((state) => {
      const { [repoId]: _, ...rest } = state.mcpStatus;
      return { mcpStatus: rest };
    }),

  // -- Detected Apps --
  detectedApps: [],
  setDetectedApps: (apps) => set({ detectedApps: apps }),

  // -- Experimental --
  usageInsightsEnabled: false,
  setUsageInsightsEnabled: (enabled) => set({ usageInsightsEnabled: enabled }),
  pluginManagementEnabled: false,
  setPluginManagementEnabled: (enabled) =>
    set((state) => ({
      pluginManagementEnabled: enabled,
      settingsSection: !enabled && state.settingsSection === "plugins"
        ? "experimental"
        : state.settingsSection,
      pluginSettingsIntent: enabled ? state.pluginSettingsIntent : null,
      pluginSettingsRepoId: enabled ? state.pluginSettingsRepoId : null,
      pluginSettingsTab: enabled ? state.pluginSettingsTab : "available",
    })),

  // -- Claude Code Usage --
  claudeCodeUsage: null,
  claudeCodeUsageLoading: false,
  claudeCodeUsageError: null,
  setClaudeCodeUsage: (usage) =>
    set({ claudeCodeUsage: usage, claudeCodeUsageError: null }),
  setClaudeCodeUsageLoading: (loading) =>
    set({ claudeCodeUsageLoading: loading }),
  setClaudeCodeUsageError: (error) =>
    set({ claudeCodeUsageError: error, claudeCodeUsageLoading: false }),

  // -- Metrics --
  dashboardMetrics: null,
  analyticsMetrics: null,
  workspaceMetrics: {},
  metricsError: null,
  setDashboardMetrics: (metrics) =>
    set({ dashboardMetrics: metrics, metricsError: null }),
  setAnalyticsMetrics: (metrics) =>
    set({ analyticsMetrics: metrics, metricsError: null }),
  setWorkspaceMetrics: (metrics) => set({ workspaceMetrics: metrics }),
  fetchDashboardMetrics: async () => {
    try {
      const metrics = await getDashboardMetrics();
      set({ dashboardMetrics: metrics, metricsError: null });
    } catch (e) {
      set({ metricsError: String(e) });
    }
  },
  fetchAnalyticsMetrics: async () => {
    try {
      const metrics = await getAnalyticsMetrics();
      set({ analyticsMetrics: metrics, metricsError: null });
    } catch (e) {
      set({ metricsError: String(e) });
    }
  },
  fetchWorkspaceMetricsBatch: async (ids) => {
    if (ids.length === 0) {
      set({ workspaceMetrics: {}, metricsError: null });
      return;
    }
    try {
      const metrics = await getWorkspaceMetricsBatch(ids);
      set({ workspaceMetrics: metrics, metricsError: null });
    } catch (e) {
      set({ metricsError: String(e) });
    }
  },

  // -- Updater --
  updateAvailable: false,
  updateVersion: null,
  updateDismissed: false,
  updateInstallWhenIdle: false,
  updateDownloading: false,
  updateProgress: 0,
  updateChannel: "stable",
  setUpdateAvailable: (available, version) =>
    set((state) => ({
      updateAvailable: available,
      updateVersion: version,
      updateDismissed:
        version === state.updateVersion ? state.updateDismissed : false,
    })),
  setUpdateDismissed: (dismissed) => set({ updateDismissed: dismissed }),
  setUpdateInstallWhenIdle: (enabled) =>
    set({ updateInstallWhenIdle: enabled }),
  setUpdateDownloading: (downloading) =>
    set({ updateDownloading: downloading }),
  setUpdateProgress: (progress) => set({ updateProgress: progress }),
  setUpdateChannel: (channel) =>
    set({
      updateChannel: channel,
      updateAvailable: false,
      updateVersion: null,
      updateDismissed: false,
      updateInstallWhenIdle: false,
    }),

  // -- App info --
  appVersion: null,
  setAppVersion: (version) => set({ appVersion: version }),

  // -- Slash commands --
  slashCommandsByWorkspace: {},
  setSlashCommands: (wsId, cmds) =>
    set((s) => ({
      slashCommandsByWorkspace: { ...s.slashCommandsByWorkspace, [wsId]: cmds },
    })),
}));

// Expose store on window in dev builds for debug_eval_js access.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__CLAUDETTE_STORE__ =
    useAppStore;
}
