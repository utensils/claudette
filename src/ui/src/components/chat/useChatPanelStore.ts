import { useTranslation } from "react-i18next";

import { tooltipWithHotkey } from "../../hotkeys/display";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import type { QueuedMessage } from "../../stores/useAppStore";
import { useAppStore } from "../../stores/useAppStore";
import { isWorkspaceEnvironmentPreparing } from "../../utils/workspaceEnvironment";
import { EMPTY_ACTIVITIES } from "./chatConstants";

const EMPTY_QUEUED_MESSAGES: QueuedMessage[] = [];

export function useChatPanelStore() {
  const { t } = useTranslation("chat");
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaceEnvironmentPreparing = useAppStore((s) =>
    isWorkspaceEnvironmentPreparing(s, s.selectedWorkspaceId),
  );
  const workspaceEnvironmentError = useAppStore((s) =>
    s.selectedWorkspaceId &&
    s.workspaceEnvironment[s.selectedWorkspaceId]?.status === "error"
      ? s.workspaceEnvironment[s.selectedWorkspaceId]?.error ??
        t("environment_error_fallback", {
          defaultValue: "Workspace environment setup failed.",
        })
      : null,
  );
  const activeSessionId = useAppStore((s) =>
    s.selectedWorkspaceId
      ? s.selectedSessionIdByWorkspaceId[s.selectedWorkspaceId] ?? null
      : null,
  );
  const activeSessionIdsKey = useAppStore((s) =>
    selectedWorkspaceId
      ? (s.sessionsByWorkspace[selectedWorkspaceId] ?? [])
          .map((session) => session.id)
          .join("\0")
      : "",
  );
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const chatMessages = useAppStore((s) => s.chatMessages);
  const setChatMessages = useAppStore((s) => s.setChatMessages);
  // Treat `null` (probe-in-flight) as available so we don't briefly hide the
  // Download menu item on a working host.
  const fileDialogAvailable = useAppStore((s) => s.fileDialogAvailable);
  const browseAvailable = fileDialogAvailable !== false;
  const runningSetupScriptSource = useAppStore((s) =>
    activeSessionId ? s.runningSetupScripts[activeSessionId] : undefined,
  );
  const hydrateCompletedTurns = useAppStore((s) => s.hydrateCompletedTurns);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const enqueueTerminalCommand = useAppStore((s) => s.enqueueTerminalCommand);
  const setChatPagination = useAppStore((s) => s.setChatPagination);
  const chatPaginationState = useAppStore((s) =>
    activeSessionId ? s.chatPagination[activeSessionId] : undefined,
  );
  const openPluginSettings = useAppStore((s) => s.openPluginSettings);
  const usageInsightsEnabled = useAppStore((s) => s.usageInsightsEnabled);
  const openSettings = useAppStore((s) => s.openSettings);
  const appVersion = useAppStore((s) => s.appVersion);
  const keybindings = useAppStore((s) => s.keybindings);
  const slashCommandsByWorkspace = useAppStore((s) => s.slashCommandsByWorkspace);
  const setSlashCommandsCache = useAppStore((s) => s.setSlashCommands);
  const isSteeringQueued = useAppStore((s) =>
    activeSessionId ? s.queuedMessageSteering[activeSessionId] === true : false,
  );
  const pendingSteerContent = useAppStore((s) =>
    activeSessionId ? s.queuedMessageSteeringContent[activeSessionId] ?? null : null,
  );
  const setQueuedMessageEditing = useAppStore((s) => s.setQueuedMessageEditing);
  const setQueuedMessageSteering = useAppStore((s) => s.setQueuedMessageSteering);
  const chatSearchOpen = useAppStore((s) =>
    selectedWorkspaceId ? s.chatSearch[selectedWorkspaceId]?.open ?? false : false,
  );
  const chatSearchQuery = useAppStore((s) =>
    selectedWorkspaceId ? s.chatSearch[selectedWorkspaceId]?.query ?? "" : "",
  );
  const defaultBranchesMap = useAppStore((s) => s.defaultBranches);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const repo = repositories.find((r) => r.id === ws?.repository_id);
  const defaultBranch = repo ? defaultBranchesMap[repo.id] : undefined;

  const pendingForkSourceName = useAppStore((s) => {
    if (!s.selectedWorkspaceId) return null;
    const sourceId = s.pendingForks[s.selectedWorkspaceId];
    if (!sourceId) return null;
    return s.workspaces.find((w) => w.id === sourceId)?.name ?? null;
  });
  const pendingCreateRepoName = useAppStore((s) => {
    if (!s.selectedWorkspaceId) return null;
    const repoId = s.pendingCreates[s.selectedWorkspaceId];
    if (!repoId) return null;
    return s.repositories.find((r) => r.id === repoId)?.name ?? null;
  });
  const pendingCreateWorkspaceName = useAppStore((s) => {
    if (!s.selectedWorkspaceId) return null;
    if (!s.pendingCreates[s.selectedWorkspaceId]) return null;
    return s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.name ?? null;
  });
  const activeSessionCount = useAppStore((s) =>
    selectedWorkspaceId
      ? (s.sessionsByWorkspace[selectedWorkspaceId] ?? []).filter(
          (sess) => sess.status === "Active",
        ).length
      : 0,
  );
  const diffTabCount = useAppStore((s) =>
    selectedWorkspaceId
      ? (s.diffTabsByWorkspace[selectedWorkspaceId] ?? []).length
      : 0,
  );
  const fileTabCount = useAppStore((s) =>
    selectedWorkspaceId
      ? (s.fileTabsByWorkspace[selectedWorkspaceId] ?? []).length
      : 0,
  );
  const sessionsLoaded = useAppStore((s) =>
    selectedWorkspaceId
      ? s.sessionsLoadedByWorkspace[selectedWorkspaceId] === true
      : false,
  );
  const noOpenTabs =
    sessionsLoaded &&
    activeSessionCount === 0 &&
    diffTabCount === 0 &&
    fileTabCount === 0;
  const messages = activeSessionId ? chatMessages[activeSessionId] || [] : [];
  const hasMore = chatPaginationState?.hasMore ?? false;
  const isLoadingMore = chatPaginationState?.isLoadingMore ?? false;
  const paginationTotalCount = chatPaginationState?.totalCount ?? messages.length;
  const oldestMessageId = chatPaginationState?.oldestMessageId ?? null;
  const globalOffset = paginationTotalCount - messages.length;

  const hasStreaming = useAppStore(
    (s) => !!(activeSessionId && s.streamingContent[activeSessionId]),
  );
  const hasPendingTypewriter = useAppStore(
    (s) => !!(activeSessionId && s.pendingTypewriter[activeSessionId]),
  );
  const hasThinking = useAppStore(
    (s) => !!(activeSessionId && s.streamingThinking[activeSessionId]),
  );
  const showThinkingBlocks = useAppStore((s) =>
    activeSessionId ? s.showThinkingBlocks[activeSessionId] === true : false,
  );
  const activitiesCount = useAppStore((s) =>
    activeSessionId
      ? (s.toolActivities[activeSessionId] ?? EMPTY_ACTIVITIES).length
      : 0,
  );
  const completedTurnsCount = useAppStore((s) =>
    activeSessionId ? (s.completedTurns[activeSessionId] || []).length : 0,
  );
  const setPermissionLevel = useAppStore((s) => s.setPermissionLevel);
  const pendingQuestion = useAppStore((s) =>
    activeSessionId ? s.agentQuestions[activeSessionId] ?? null : null,
  );
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);
  const pendingPlan = useAppStore((s) =>
    activeSessionId ? s.planApprovals[activeSessionId] ?? null : null,
  );
  const clearPlanApproval = useAppStore((s) => s.clearPlanApproval);
  const pendingApproval = useAppStore((s) =>
    activeSessionId ? s.agentApprovals[activeSessionId] ?? null : null,
  );
  const clearAgentApproval = useAppStore((s) => s.clearAgentApproval);
  const queuedMessages = useAppStore((s) =>
    activeSessionId
      ? s.queuedMessages[activeSessionId] ?? EMPTY_QUEUED_MESSAGES
      : EMPTY_QUEUED_MESSAGES,
  );
  const setQueuedMessage = useAppStore((s) => s.setQueuedMessage);
  const updateQueuedMessage = useAppStore((s) => s.updateQueuedMessage);
  const removeQueuedMessage = useAppStore((s) => s.removeQueuedMessage);
  const clearQueuedMessage = useAppStore((s) => s.clearQueuedMessage);
  const setQueuedMessageAutoDispatchPaused = useAppStore(
    (s) => s.setQueuedMessageAutoDispatchPaused,
  );
  const addCheckpoint = useAppStore((s) => s.addCheckpoint);
  const beginPendingFork = useAppStore((s) => s.beginPendingFork);
  const commitPendingFork = useAppStore((s) => s.commitPendingFork);
  const cancelPendingFork = useAppStore((s) => s.cancelPendingFork);
  const toolDisplayMode = useAppStore((s) => s.toolDisplayMode);
  const activeSessionStatus = useAppStore((s) => {
    if (!activeSessionId || !selectedWorkspaceId) return "Idle" as const;
    const sessions = s.sessionsByWorkspace[selectedWorkspaceId];
    return (
      sessions?.find((sess) => sess.id === activeSessionId)?.agent_status ??
      ("Idle" as const)
    );
  });
  const activeChatSessionRecord = useAppStore((s) =>
    selectedWorkspaceId
      ? (s.sessionsByWorkspace[selectedWorkspaceId] ?? []).find(
          (cs) => cs.id === activeSessionId,
        ) ?? null
      : null,
  );
  const showChatAuthLoginPanel = useAppStore((s) => s.chatAuthLoginPanelOpen);
  const chatAuthLoginRequestId = useAppStore((s) => s.chatAuthLoginRequestId);
  const chatAuthLoginStartedRequestId = useAppStore(
    (s) => s.chatAuthLoginStartedRequestId,
  );
  const openChatAuthLoginPanel = useAppStore((s) => s.openChatAuthLoginPanel);
  const setChatAuthLoginStartedRequestId = useAppStore(
    (s) => s.setChatAuthLoginStartedRequestId,
  );

  const isMac = isMacHotkeyPlatform();
  const isRunning = activeSessionStatus === "Running";
  const searchQuery = chatSearchOpen ? chatSearchQuery : "";
  const steerQueuedTooltip = tooltipWithHotkey(
    t("steer_queued"),
    "chat.steer-immediate",
    keybindings,
    isMac,
  );

  return {
    activeChatSessionRecord,
    activeSessionId,
    activeSessionIdsKey,
    activeSessionStatus,
    addChatMessage,
    addCheckpoint,
    appVersion,
    beginPendingFork,
    browseAvailable,
    cancelPendingFork,
    chatAuthLoginRequestId,
    chatAuthLoginStartedRequestId,
    clearAgentApproval,
    clearAgentQuestion,
    clearPlanApproval,
    clearQueuedMessage,
    commitPendingFork,
    completedTurnsCount,
    defaultBranch,
    enqueueTerminalCommand,
    globalOffset,
    hasMore,
    hasPendingTypewriter,
    hasStreaming,
    hasThinking,
    hydrateCompletedTurns,
    isLoadingMore,
    isRunning,
    isSteeringQueued,
    messages,
    noOpenTabs,
    oldestMessageId,
    openChatAuthLoginPanel,
    openPluginSettings,
    openSettings,
    pendingApproval,
    pendingCreateRepoName,
    pendingCreateWorkspaceName,
    pendingForkSourceName,
    pendingPlan,
    pendingQuestion,
    pendingSteerContent,
    queuedMessages,
    removeQueuedMessage,
    repo,
    runningSetupScriptSource,
    searchQuery,
    selectedWorkspaceId,
    sessionsLoaded,
    setChatAuthLoginStartedRequestId,
    setChatMessages,
    setChatPagination,
    setPermissionLevel,
    setQueuedMessage,
    setQueuedMessageAutoDispatchPaused,
    setQueuedMessageEditing,
    setQueuedMessageSteering,
    setSlashCommandsCache,
    showChatAuthLoginPanel,
    showThinkingBlocks,
    slashCommandsByWorkspace,
    steerQueuedTooltip,
    toolDisplayMode,
    updateQueuedMessage,
    usageInsightsEnabled,
    workspaceEnvironmentError,
    workspaceEnvironmentPreparing,
    ws,
    activitiesCount,
  };
}
