import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  CornerDownRight,
  LoaderCircle,
  SendHorizontal,
  Trash2,
} from "lucide-react";
import { ChatSearchBar } from "./ChatSearchBar";
import { OverlayScrollbar } from "./OverlayScrollbar";
import { useAppStore } from "../../stores/useAppStore";
import {
  loadAttachmentData,
  loadChatHistoryPage,
  loadAttachmentsForSession,
  listCheckpoints,
  listSlashCommands,
  loadCompletedTurns,
  openReleaseNotes,
  openUsageSettings,
  recordSlashCommandUsage,
  sendChatMessage,
  sendRemoteCommand,
  steerQueuedChatMessage,
  stopAgent,
  submitAgentAnswer,
  submitPlanApproval,
  getAppSetting,
  setAppSetting,
  clearConversation,
  readPlanFile,
  loadDiffFiles,
  forkWorkspaceAtCheckpoint,
} from "../../services/tauri";
import { applySelectedModel } from "./applySelectedModel";
import { findLatestPlanFilePath } from "./planFilePath";
import type { PermissionLevel, QueuedMessage } from "../../stores/useAppStore";
import { reconstructCompletedTurns } from "../../utils/reconstructTurns";
import { extractLatestCallUsage } from "../../utils/extractLatestCallUsage";
import type { AttachmentInput, ChatMessage } from "../../types/chat";
import { debugChat } from "../../utils/chatDebug";
import { AttachmentContextMenu } from "./AttachmentContextMenu";
import { buildAttachmentMenuLabels } from "./attachmentContextMenuLabels";
import { AttachmentLightbox } from "./AttachmentLightbox";
import {
  downloadAttachment,
  openAttachmentInBrowser,
  openAttachmentWithDefaultApp,
  copyAttachmentToClipboard,
  shareAttachment,
  isShareSupported,
  type DownloadableAttachment,
} from "../../utils/attachmentDownload";
import {
  parseSlashInput,
  resolveNativeHandler,
} from "./nativeSlashCommands";
import { resolveUltrathinkEffort } from "./ultrathink";
import { extractCompactionEvents } from "../../utils/compactionSentinel";
import { WorkspacePanelHeader } from "../shared/WorkspacePanelHeader";
import { SessionTabs } from "./SessionTabs";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { ScrollToBottomPill } from "./ScrollToBottomPill";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import { tooltipWithHotkey } from "../../hotkeys/display";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import { usePreventScrollBounce } from "../../hooks/usePreventScrollBounce";
import styles from "./ChatPanel.module.css";
import { shouldDisable1mContext, formatElapsedSeconds } from "./chatHelpers";
import { ScrollContext } from "./ScrollContext";
import { StreamingThinkingBlock } from "./StreamingThinkingBlock";
import { StreamingMessage } from "./StreamingMessage";
import { MessagesWithTurns } from "./MessagesWithTurns";
import { CliInvocationBanner } from "./CliInvocationBanner";
import { CurrentTurnTaskProgress } from "./CurrentTurnTaskProgress";
import { ChatInputArea } from "./ChatInputArea";
import { EMPTY_ACTIVITIES } from "./chatConstants";

const EMPTY_QUEUED_MESSAGES: QueuedMessage[] = [];

export function ChatPanel() {
  const { t } = useTranslation("chat");
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaceEnvironmentPreparing = useAppStore((s) => {
    if (!s.selectedWorkspaceId) return false;
    const workspace = s.workspaces.find((w) => w.id === s.selectedWorkspaceId);
    if (!workspace || workspace.remote_connection_id) return false;
    const status = s.workspaceEnvironment[s.selectedWorkspaceId]?.status;
    return status !== "ready" && status !== "error";
  });
  const activeSessionId = useAppStore((s) =>
    s.selectedWorkspaceId
      ? s.selectedSessionIdByWorkspaceId[s.selectedWorkspaceId] ?? null
      : null,
  );
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const chatMessages = useAppStore((s) => s.chatMessages);
  const setChatMessages = useAppStore((s) => s.setChatMessages);
  const hydrateCompletedTurns = useAppStore((s) => s.hydrateCompletedTurns);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const enqueueTerminalCommand = useAppStore((s) => s.enqueueTerminalCommand);
  const setChatPagination = useAppStore((s) => s.setChatPagination);
  const chatPaginationState = useAppStore((s) =>
    activeSessionId ? s.chatPagination[activeSessionId] : undefined,
  );
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const openPluginSettings = useAppStore((s) => s.openPluginSettings);
  const pluginManagementEnabled = useAppStore((s) => s.pluginManagementEnabled);
  const usageInsightsEnabled = useAppStore((s) => s.usageInsightsEnabled);
  const openSettings = useAppStore((s) => s.openSettings);
  const appVersion = useAppStore((s) => s.appVersion);
  const keybindings = useAppStore((s) => s.keybindings);
  const slashCommandsByWorkspace = useAppStore((s) => s.slashCommandsByWorkspace);
  const setSlashCommandsCache = useAppStore((s) => s.setSlashCommands);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const processingRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSteeringQueued, setIsSteeringQueued] = useState(false);
  const isMac = isMacHotkeyPlatform();
  const steerQueuedTooltip = tooltipWithHotkey(
    t("steer_queued"),
    "chat.steer-immediate",
    keybindings,
    isMac,
  );

  // Cmd/Ctrl+F search bar state. `searchQuery` flows down to message
  // renderers as the highlight trigger; an empty string short-circuits the
  // wrappers' DOM-walk pass entirely, so search-off has zero render cost.
  const chatSearchOpen = useAppStore(
    (s) => (selectedWorkspaceId ? s.chatSearch[selectedWorkspaceId]?.open ?? false : false),
  );
  const chatSearchQuery = useAppStore(
    (s) => (selectedWorkspaceId ? s.chatSearch[selectedWorkspaceId]?.query ?? "" : ""),
  );
  const searchQuery = chatSearchOpen ? chatSearchQuery : "";

  const [attachmentMenu, setAttachmentMenu] = useState<{
    x: number;
    y: number;
    attachment: DownloadableAttachment;
    /** Persisted PDFs hydrate without data_base64 (it's stripped to keep
     *  the initial IPC small). When the menu fires for one, hold the row
     *  id so each action can lazy-load the bytes via loadAttachmentData
     *  before downloading / copying. */
    attachmentId?: string;
  } | null>(null);

  const openAttachmentMenu = useCallback(
    (e: React.MouseEvent, attachment: DownloadableAttachment, attachmentId?: string) => {
      e.preventDefault();
      setAttachmentMenu({
        x: e.clientX,
        y: e.clientY,
        attachment,
        attachmentId,
      });
    },
    [],
  );

  /** Resolves an attachment's data_base64, fetching from the backend on
   *  demand if it was stripped during hydration. Returns a fresh object
   *  so callers can pass it straight into download / copy helpers. */
  const ensureAttachmentBytes = useCallback(
    async (
      attachment: DownloadableAttachment,
      attachmentId?: string,
    ): Promise<DownloadableAttachment> => {
      if (attachment.data_base64 || !attachmentId) return attachment;
      const data_base64 = await loadAttachmentData(attachmentId);
      return { ...attachment, data_base64 };
    },
    [],
  );

  const [lightbox, setLightbox] = useState<{
    attachment: DownloadableAttachment;
    returnFocus: HTMLElement | null;
  } | null>(null);

  const openLightbox = useCallback(
    (e: React.MouseEvent, attachment: DownloadableAttachment) => {
      setLightbox({
        attachment,
        returnFocus: (e.currentTarget as HTMLElement) ?? null,
      });
    },
    [],
  );

  // navigator.canShare({ files: [probe] }) doesn't change across re-renders —
  // it's a function of the platform / webview capabilities. Compute once.
  const shareSupported = useMemo(() => isShareSupported(), []);

  // Prompt history: stores past user inputs per session.
  const historyRef = useRef<Record<string, string[]>>({});
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");

  const defaultBranchesMap = useAppStore((s) => s.defaultBranches);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const repo = repositories.find((r) => r.id === ws?.repository_id);
  const defaultBranch = repo ? defaultBranchesMap[repo.id] : undefined;
  const messages = activeSessionId
    ? chatMessages[activeSessionId] || []
    : [];
  const hasMore = chatPaginationState?.hasMore ?? false;
  const isLoadingMore = chatPaginationState?.isLoadingMore ?? false;
  const paginationTotalCount = chatPaginationState?.totalCount ?? messages.length;
  const oldestMessageId = chatPaginationState?.oldestMessageId ?? null;
  // Global 0-based index of the first loaded message in the full message sequence.
  // Zero for new/fully-loaded sessions; positive for paginated sessions where
  // older messages have not been fetched yet.
  const globalOffset = paginationTotalCount - messages.length;

  // Subscribe only to boolean — avoids re-render on every streaming character
  const hasStreaming = useAppStore(
    (s) => !!(activeSessionId && s.streamingContent[activeSessionId])
  );
  const hasThinking = useAppStore(
    (s) => !!(activeSessionId && s.streamingThinking[activeSessionId])
  );
  const showThinkingBlocks = useAppStore(
    (s) => activeSessionId ? s.showThinkingBlocks[activeSessionId] === true : false
  );
  const activitiesCount = useAppStore(
    (s) => (activeSessionId ? (s.toolActivities[activeSessionId] ?? EMPTY_ACTIVITIES).length : 0),
  );
  const completedTurnsCount = useAppStore(
    (s) => (activeSessionId ? (s.completedTurns[activeSessionId] || []).length : 0)
  );
  const permissionLevelMap = useAppStore((s) => s.permissionLevel);
  const setPermissionLevel = useAppStore((s) => s.setPermissionLevel);
  const permissionLevel = activeSessionId
    ? permissionLevelMap[activeSessionId] ?? "full"
    : "full";
  const pendingQuestion = useAppStore(
    (s) => (activeSessionId ? s.agentQuestions[activeSessionId] ?? null : null)
  );
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);
  const pendingPlan = useAppStore(
    (s) => (activeSessionId ? s.planApprovals[activeSessionId] ?? null : null)
  );
  const clearPlanApproval = useAppStore((s) => s.clearPlanApproval);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const queuedMessages = useAppStore(
    (s) =>
      activeSessionId
        ? s.queuedMessages[activeSessionId] ?? EMPTY_QUEUED_MESSAGES
        : EMPTY_QUEUED_MESSAGES,
  );
  const setQueuedMessage = useAppStore((s) => s.setQueuedMessage);
  const removeQueuedMessage = useAppStore((s) => s.removeQueuedMessage);
  const clearQueuedMessage = useAppStore((s) => s.clearQueuedMessage);
  const addCheckpoint = useAppStore((s) => s.addCheckpoint);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const toolDisplayMode = useAppStore((s) => s.toolDisplayMode);
  const activeSessionStatus = useAppStore((s) => {
    if (!activeSessionId || !selectedWorkspaceId) return "Idle" as const;
    const sessions = s.sessionsByWorkspace[selectedWorkspaceId];
    return sessions?.find((sess) => sess.id === activeSessionId)?.agent_status ?? "Idle" as const;
  });
  const isRunning = activeSessionStatus === "Running";
  const activeChatSessionRecord = useAppStore((s) =>
    selectedWorkspaceId
      ? (s.sessionsByWorkspace[selectedWorkspaceId] ?? []).find(
          (cs) => cs.id === activeSessionId,
        ) ?? null
      : null,
  );
  const cliInvocation = activeChatSessionRecord?.cli_invocation ?? null;

  const isRemote = !!ws?.remote_connection_id;

  const handleFork = useCallback(
    async (checkpointId: string) => {
      if (!selectedWorkspaceId || isRemote) return;
      try {
        const result = await forkWorkspaceAtCheckpoint(
          selectedWorkspaceId,
          checkpointId,
        );
        addWorkspace(result.workspace);
        selectWorkspace(result.workspace.id);
      } catch (err) {
        setError(`Failed to fork workspace: ${err}`);
      }
    },
    [selectedWorkspaceId, isRemote, addWorkspace, selectWorkspace],
  );

  // Sticky scroll: auto-follow when at bottom, stop when user scrolls up.
  const { isAtBottom, scrollToBottom, handleContentChanged } =
    useStickyScroll(messagesContainerRef);
  usePreventScrollBounce(messagesContainerRef);

  // Memoize context value to avoid re-rendering StreamingMessage on every parent render.
  const scrollContextValue = useMemo(
    () => ({ handleContentChanged }),
    [handleContentChanged],
  );

  // Elapsed timer for running agent.
  const promptStartTime = useAppStore(
    (s) => (selectedWorkspaceId ? s.promptStartTime[selectedWorkspaceId] ?? null : null)
  );
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || promptStartTime == null) return;
    setElapsed(Math.floor((Date.now() - promptStartTime) / 1000));
    const interval = setInterval(() => {
      const newElapsed = Math.floor((Date.now() - promptStartTime) / 1000);
      setElapsed((prev) => (prev === newElapsed ? prev : newElapsed));
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning, promptStartTime]);

  const formatElapsed = formatElapsedSeconds;

  // Load persisted permission level when the active session changes.
  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;
    getAppSetting(`permission_level:${activeSessionId}`)
      .then((val) => {
        if (cancelled) return;
        if (val === "readonly" || val === "standard" || val === "full") {
          setPermissionLevel(activeSessionId, val);
        }
      })
      .catch((err) => {
        console.error("Failed to load permission level:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, setPermissionLevel]);

  // Load chat history when the active session changes, seed prompt history from it.
  useEffect(() => {
    if (!activeSessionId || !selectedWorkspaceId) return;
    let cancelled = false;
    setError(null);
    historyIndexRef.current = -1;
    draftRef.current = "";

    const currentWs = useAppStore
      .getState()
      .workspaces.find((w) => w.id === selectedWorkspaceId);
    const sessionId = activeSessionId;
    const isLocal = !currentWs?.remote_connection_id;

    debugChat("ChatPanel", "load-history:start", {
      sessionId,
      isLocal,
      agentStatus: currentWs?.agent_status ?? null,
    });

    const onMessages = (msgs: ChatMessage[], attachments?: import("../../types").ChatAttachment[], pageState?: import("../../types").ChatPaginationState) => {
      if (cancelled) return;
      // The paginated backend already drops legacy empty-assistant rows so
      // `total_count` matches the page contents. The remote (non-paginated)
      // path still needs the filter — apply it only when no pageState exists.
      const filtered = pageState
        ? msgs
        : msgs.filter(
            (m) => m.role !== "Assistant" || m.content.trim() !== "" || !!m.thinking
          );
      debugChat("ChatPanel", "load-history:success", {
        sessionId,
        rawMessageCount: msgs.length,
        filteredMessageCount: filtered.length,
        messageIds: filtered.map((msg) => msg.id),
      });
      setChatMessages(sessionId, filtered);
      if (attachments) {
        useAppStore.getState().setChatAttachments(sessionId, attachments);
      }
      if (pageState) {
        setChatPagination(sessionId, pageState);
      }
      // Global index of the first loaded message — needed below so persisted
      // CompletedTurn rows whose checkpoint sits inside the loaded window
      // resolve to the correct GLOBAL afterMessageIndex.
      const loadGlobalOffset = pageState
        ? pageState.totalCount - filtered.length
        : 0;
      historyRef.current[sessionId] = filtered
        .filter((m) => m.role === "User")
        .map((m) => m.content);
      // Seed the ContextMeter from the last assistant message's per-call
      // token data. If none is available (fresh / pre-migration workspace),
      // clear any stale value so the meter hides.
      const callUsage = extractLatestCallUsage(filtered);
      const store = useAppStore.getState();
      if (callUsage) store.setLatestTurnUsage(sessionId, callUsage);
      else store.clearLatestTurnUsage(sessionId);
      // Phase 3: seed compactionEvents by scanning for COMPACTION: sentinels.
      store.setCompactionEvents(sessionId, extractCompactionEvents(filtered));

      // Load persisted completed turns and reconstruct with correct positions.
      // Skip if the agent is currently running — the in-memory state from
      // finalizeTurn() is more current than the DB and must not be overwritten.
      if (isLocal) {
        const sessions = useAppStore.getState().sessionsByWorkspace[selectedWorkspaceId] ?? [];
        const thisSession = sessions.find((s) => s.id === sessionId);
        const isRunning = thisSession?.agent_status === "Running";
        debugChat("ChatPanel", "load-completed-turns:gate", {
          sessionId,
          isRunning,
          currentCompletedTurnIds: (useAppStore.getState().completedTurns[sessionId] || []).map(
            (turn) => turn.id
          ),
        });
        if (!isRunning) {
          loadCompletedTurns(sessionId)
            .then((turnData) => {
              if (cancelled) return;
              const turns = reconstructCompletedTurns(filtered, turnData, loadGlobalOffset);
              debugChat("ChatPanel", "load-completed-turns:success", {
                sessionId,
                dbTurnIds: turnData.map((turn) => turn.checkpoint_id),
                reconstructedTurnIds: turns.map((turn) => turn.id),
              });
              hydrateCompletedTurns(sessionId, turns);
            })
            .catch((e) => console.error("Failed to load completed turns:", e));
        }
      }
    };

    if (isLocal) {
      // Skip the reload when we've already loaded this session — otherwise
      // bouncing between long conversations would drop any older pages the
      // user already scrolled through and snap them back to the newest 50.
      // CompletedTurns and attachments are kept live in the store via the
      // streaming path, so re-fetching from the DB here would also clobber
      // in-flight state.
      const existingPagination =
        useAppStore.getState().chatPagination[sessionId];
      if (existingPagination) {
        debugChat("ChatPanel", "load-history:skip-already-loaded", {
          sessionId,
          totalCount: existingPagination.totalCount,
        });
      } else {
        // Load newest page of messages and their attachments in one round-trip.
        loadChatHistoryPage(sessionId, 50)
          .then((page) => {
            onMessages(page.messages, page.attachments, {
              hasMore: page.has_more,
              isLoadingMore: false,
              totalCount: page.total_count,
              oldestMessageId: page.messages[0]?.id ?? null,
            });
          })
          .catch((e) => console.error("Failed to load chat history:", e));
      }
    } else {
      sendRemoteCommand(currentWs!.remote_connection_id!, "load_chat_history", {
        chat_session_id: sessionId,
      })
        .then((data) => {
          const msgs = (data as { messages?: ChatMessage[] })?.messages ?? (data as ChatMessage[]);
          onMessages(msgs);
        })
        .catch((e) => console.error("Failed to load chat history:", e));
    }

    // Load checkpoints for rollback support.
    if (isLocal) {
      const setCheckpoints = useAppStore.getState().setCheckpoints;
      listCheckpoints(sessionId)
        .then((cps) => {
          if (cancelled) return;
          setCheckpoints(sessionId, cps);
        })
        .catch((e) => console.error("Failed to load checkpoints:", e));
    }

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, selectedWorkspaceId, setChatMessages, setChatPagination, hydrateCompletedTurns]);

  // Scroll to bottom unconditionally on session switch.
  useEffect(() => {
    if (activeSessionId) scrollToBottom();
  }, [activeSessionId, scrollToBottom]);

  // Load older messages when the user scrolls to the top of the message list.
  const hasMoreRef = useRef(false);
  hasMoreRef.current = hasMore;
  const isLoadingMoreRef = useRef(false);
  isLoadingMoreRef.current = isLoadingMore;
  const oldestMessageIdRef = useRef<string | null>(null);
  oldestMessageIdRef.current = oldestMessageId;
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const onScroll = () => {
      if (
        container.scrollTop < 200 &&
        hasMoreRef.current &&
        !isLoadingMoreRef.current &&
        activeSessionIdRef.current &&
        oldestMessageIdRef.current
      ) {
        const sessionId = activeSessionIdRef.current;
        const cursorId = oldestMessageIdRef.current;
        const store = useAppStore.getState();
        const pagination = store.chatPagination[sessionId];
        if (!pagination) return;

        // Flip the ref synchronously: subsequent scroll events fire before
        // React commits the store update, so without this guard fast scrolls
        // at the top can dispatch multiple page fetches with the same cursor
        // and prepend the same rows repeatedly.
        isLoadingMoreRef.current = true;
        store.setChatPagination(sessionId, { ...pagination, isLoadingMore: true });
        const prevScrollHeight = container.scrollHeight;

        loadChatHistoryPage(sessionId, 50, cursorId)
          .then((page) => {
            // Staleness guard: if the user switched sessions, cleared the
            // conversation, or scrolled further while this fetch was in
            // flight, the response is no longer applicable. Bail before
            // mutating any state — applying it would prepend old rows back
            // into a session that has moved on. We still reset the source
            // session's `isLoadingMore` flag if it's safe (pagination state
            // unchanged for that session), so the user can retry on return.
            const liveStore = useAppStore.getState();
            const livePagination = liveStore.chatPagination[sessionId];
            const stillCurrent =
              activeSessionIdRef.current === sessionId &&
              livePagination &&
              livePagination.oldestMessageId === cursorId;
            if (!stillCurrent) {
              if (livePagination && livePagination.isLoadingMore) {
                liveStore.setChatPagination(sessionId, {
                  ...livePagination,
                  isLoadingMore: false,
                });
              }
              return;
            }
            liveStore.prependChatMessages(sessionId, page.messages);
            liveStore.prependChatAttachments(sessionId, page.attachments);
            // Merge live `totalCount` (which may have grown via streaming
            // `addChatMessage` while the request was in flight) with the
            // server snapshot. `totalCount` must stay monotonic per session
            // — moving it backwards would shift `globalOffset` and corrupt
            // CompletedTurn placement until the next full reload.
            const liveTotal =
              useAppStore.getState().chatPagination[sessionId]?.totalCount ?? 0;
            liveStore.setChatPagination(sessionId, {
              hasMore: page.has_more,
              isLoadingMore: false,
              totalCount: Math.max(page.total_count, liveTotal),
              oldestMessageId: page.messages[0]?.id ?? cursorId,
            });
            // Backfill prompt history: Shift+Up walks `historyRef`, which was
            // seeded from the initial page only. Without this, older user
            // messages stay invisible to history navigation even after the
            // user scrolls them into view.
            const olderUserPrompts = page.messages
              .filter((m) => m.role === "User")
              .map((m) => m.content);
            if (olderUserPrompts.length > 0) {
              const existing = historyRef.current[sessionId] ?? [];
              historyRef.current[sessionId] = [
                ...olderUserPrompts,
                ...existing,
              ];
            }
            // Restore scroll position so prepended messages don't push the
            // view upward.
            requestAnimationFrame(() => {
              container.scrollTop += container.scrollHeight - prevScrollHeight;
            });
            // Re-hydrate persisted completed turns: any whose checkpoint
            // message_id was in the just-loaded older range was filtered out
            // of `reconstructCompletedTurns` on the initial load. Re-running
            // against the now-larger message window resolves them.
            const merged =
              useAppStore.getState().chatMessages[sessionId] ?? [];
            const mergedTotal =
              useAppStore.getState().chatPagination[sessionId]?.totalCount ??
              page.total_count;
            const mergedOffset = mergedTotal - merged.length;
            loadCompletedTurns(sessionId)
              .then((turnData) => {
                if (activeSessionIdRef.current !== sessionId) return;
                const turns = reconstructCompletedTurns(
                  merged,
                  turnData,
                  mergedOffset,
                );
                useAppStore
                  .getState()
                  .hydrateCompletedTurns(sessionId, turns);
              })
              .catch((err) =>
                console.error(
                  "Failed to re-hydrate completed turns after prepend:",
                  err,
                ),
              );
          })
          .catch((e) => {
            console.error("Failed to load older messages:", e);
            // Read fresh pagination state — `addChatMessage` may have
            // incremented `totalCount` while the fetch was in flight, and
            // writing back the captured snapshot here would clobber it.
            const live = useAppStore.getState().chatPagination[sessionId];
            if (!live) return; // session was cleared
            useAppStore
              .getState()
              .setChatPagination(sessionId, { ...live, isLoadingMore: false });
          })
          .finally(() => {
            // Clear the synchronous gate regardless of outcome so the next
            // top-of-scroll event can fetch again.
            isLoadingMoreRef.current = false;
          });
      }
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
    // Re-attach on session switch so the sessionId ref stays in sync.
  }, [activeSessionId]);

  // Auto-scroll when new content arrives — respects user intent via useStickyScroll.
  // Only scrolls if the user is already at/near the bottom.
  const prevMsgCountRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const sid = activeSessionId;
    if (!sid) return;
    const prev = prevMsgCountRef.current[sid] ?? 0;
    const cur = messages.length;
    prevMsgCountRef.current[sid] = cur;
    // Only trigger on genuinely new messages (count increase), not DB rehydration.
    if (cur > prev) handleContentChanged();
  }, [messages.length, activeSessionId, handleContentChanged]);

  useEffect(() => {
    if (completedTurnsCount > 0 || activitiesCount > 0 || pendingQuestion || pendingPlan) {
      handleContentChanged();
    }
  }, [completedTurnsCount, activitiesCount, pendingQuestion, pendingPlan, handleContentChanged]);

  useEffect(() => {
    if (!activeSessionId) return;
    debugChat("ChatPanel", "state", {
      sessionId: activeSessionId,
      wsId: selectedWorkspaceId,
      isRunning,
      messageCount: messages.length,
      activitiesCount,
      completedTurnsCount,
      hasStreaming,
    });
  }, [
    activeSessionId,
    selectedWorkspaceId,
    isRunning,
    messages.length,
    activitiesCount,
    completedTurnsCount,
    hasStreaming,
  ]);

  // Auto-dispatch queued message when agent becomes idle.
  const handleSendRef = useRef<((
    content: string,
    mentionedFiles?: Set<string>,
    attachments?: AttachmentInput[],
  ) => void) | null>(null);
  const autoDispatchQueuedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const nextQueuedMessage = queuedMessages[0];
    if (
      isSteeringQueued ||
      isRunning ||
      !activeSessionId ||
      !nextQueuedMessage ||
      autoDispatchQueuedIdRef.current
    ) {
      return;
    }
    // Agent just finished — dispatch the queued message.
    const { id, content, mentionedFiles, attachments } = nextQueuedMessage;
    autoDispatchQueuedIdRef.current = id;
    removeQueuedMessage(activeSessionId, id);
    const filesSet = mentionedFiles?.length ? new Set(mentionedFiles) : undefined;
    // Use a microtask to avoid calling handleSend during render.
    queueMicrotask(() => {
      handleSendRef.current?.(content, filesSet, attachments);
      autoDispatchQueuedIdRef.current = null;
    });
  }, [isSteeringQueued, isRunning, activeSessionId, queuedMessages, removeQueuedMessage]);

  if (!ws) return null;

  const addPersistedUserMessageToStore = (
    sessionId: string,
    messageId: string,
    content: string,
    attachments?: AttachmentInput[],
  ) => {
    addChatMessage(sessionId, {
      id: messageId,
      workspace_id: ws.id,
      chat_session_id: sessionId,
      role: "User",
      content,
      cost_usd: null,
      duration_ms: null,
      created_at: new Date().toISOString(),
      thinking: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
    });
    if (attachments?.length) {
      const optimisticAtts = attachments.map((a) => ({
        id: crypto.randomUUID(),
        message_id: messageId,
        filename: a.filename,
        media_type: a.media_type,
        data_base64: a.data_base64,
        text_content: a.text_content ?? null,
        width: null,
        height: null,
        size_bytes: Math.ceil(a.data_base64.length * 0.75),
      }));
      useAppStore.getState().addChatAttachments(sessionId, optimisticAtts);
    }
  };

  // Skip-queue / steer entry from the chat composer (default Cmd+Enter).
  // Mirrors handleSteerQueuedMessage but takes content from the input area
  // directly instead of the queued-message slot — the user is asking to
  // inject the freshly-typed message mid-turn instead of letting it sit
  // in the queue until the current turn finishes.
  const handleSendSteer = async (
    content: string,
    mentionedFiles?: Set<string>,
    attachments?: AttachmentInput[],
  ) => {
    const trimmed = content.trim();
    if ((!trimmed && !attachments?.length) || !activeSessionId) return;
    if (ws?.remote_connection_id) {
      // Mid-turn steering isn't supported over the remote transport yet,
      // but the typed message must NOT be lost — fall back to the normal
      // send path so it lands in the queue (which IS supported remotely).
      // ChatInputArea also catches this earlier; this is defense in depth
      // for any future caller that bypasses the composer (Copilot review).
      await handleSend(content, mentionedFiles, attachments);
      return;
    }
    if (!isRunning) {
      // Defensive — ChatInputArea also falls back to handleSend when not
      // running, but the user could conceivably trigger this from another
      // entry point in the future. Route through the normal send path.
      await handleSend(content, mentionedFiles, attachments);
      return;
    }
    if (isSteeringQueued) return;

    const sessionId = activeSessionId;
    const messageId = crypto.randomUUID();
    const mentionedFilesArray = mentionedFiles?.size
      ? [...mentionedFiles]
      : undefined;
    setError(null);
    setIsSteeringQueued(true);
    try {
      const checkpoint = await steerQueuedChatMessage(
        sessionId,
        content,
        mentionedFilesArray,
        attachments,
        messageId,
      );
      if (checkpoint) {
        addCheckpoint(sessionId, checkpoint);
      }
      const history = (historyRef.current[sessionId] ??= []);
      history.push(content);
      historyIndexRef.current = -1;
      draftRef.current = "";
      addPersistedUserMessageToStore(sessionId, messageId, content, attachments);
    } catch (e) {
      const errMsg = String(e);
      console.error("steerQueuedChatMessage (skip-queue) failed:", errMsg);
      // Steer failed mid-turn — fall back to queueing so the user's typed
      // message doesn't vanish. They can re-trigger it manually.
      setQueuedMessage(sessionId, content, mentionedFilesArray, attachments);
      setError(errMsg);
    } finally {
      setIsSteeringQueued(false);
    }
  };

  const handleSteerQueuedMessage = async (queuedMessageId: string) => {
    if (!activeSessionId || isSteeringQueued) return;
    const queuedMessage = queuedMessages.find((message) => message.id === queuedMessageId);
    if (!queuedMessage) return;
    if (ws?.remote_connection_id) {
      setError("Mid-turn steering is not yet supported for remote workspaces");
      return;
    }
    if (!isRunning) {
      setError("No running agent turn to steer");
      return;
    }

    const sessionId = activeSessionId;
    const { content, mentionedFiles, attachments } = queuedMessage;
    const messageId = crypto.randomUUID();
    setError(null);
    setIsSteeringQueued(true);
    removeQueuedMessage(sessionId, queuedMessage.id);
    try {
      const checkpoint = await steerQueuedChatMessage(
        sessionId,
        content,
        mentionedFiles,
        attachments,
        messageId,
      );
      if (checkpoint) {
        addCheckpoint(sessionId, checkpoint);
      }
      const history = (historyRef.current[sessionId] ??= []);
      history.push(content);
      historyIndexRef.current = -1;
      draftRef.current = "";
      addPersistedUserMessageToStore(sessionId, messageId, content, attachments);
    } catch (e) {
      const errMsg = String(e);
      console.error("steerQueuedChatMessage failed:", errMsg);
      setQueuedMessage(sessionId, content, mentionedFiles, attachments);
      setError(errMsg);
    } finally {
      setIsSteeringQueued(false);
    }
  };

  const handleSteerQueuedTop = () => {
    const firstQueuedMessage = queuedMessages[0];
    if (!firstQueuedMessage) return;
    void handleSteerQueuedMessage(firstQueuedMessage.id);
  };

  const handleRunShellCommand = async (command: string) => {
    if (!selectedWorkspaceId) return;
    if (ws?.remote_connection_id) {
      setError("Shell commands are not yet supported for remote workspaces");
      return;
    }
    setError(null);
    enqueueTerminalCommand(selectedWorkspaceId, command);
  };

  const handleSend = async (
    content: string,
    mentionedFiles?: Set<string>,
    attachments?: AttachmentInput[],
  ) => {
    let trimmed = content.trim();
    if (
      (!trimmed && !attachments?.length) ||
      !selectedWorkspaceId ||
      !activeSessionId
    )
      return;
    const sessionId = activeSessionId;

    // Convert mentioned files set to array for the backend.
    const mentionedFilesArray = mentionedFiles?.size
      ? [...mentionedFiles]
      : undefined;

    // Native slash command dispatch. Runs before the agent send path so that
    // local_action/settings_route commands never leak to the CLI and
    // prompt_expansion commands can rewrite the prompt before it is sent.
    const parsedSlash = parseSlashInput(trimmed);
    if (parsedSlash) {
      // A user- or project-defined markdown command with the same name takes
      // priority over non-reserved natives (plugin/marketplace remain reserved
      // upstream in the backend registry). Plugin-source commands do NOT get
      // this precedence — only humans editing `.claude/commands/*.md` can
      // override built-ins. Skip native dispatch when such a shadow exists so
      // the custom markdown prompt reaches Claude.
      //
      // The slash-command cache is populated async by ChatInputArea on mount
      // and on workspace change. If a user sends a slash command before that
      // first fetch lands (rare but possible on fast startup), fall back to a
      // synchronous fetch here so shadowing decisions are always made against
      // a fresh list. The Rust side already returns a 5-minute cached result.
      let cmds = slashCommandsByWorkspace[selectedWorkspaceId];
      if (!cmds) {
        try {
          cmds = await listSlashCommands(repo?.path, selectedWorkspaceId);
          setSlashCommandsCache(selectedWorkspaceId, cmds);
        } catch (err) {
          console.error("Failed to load slash commands before native dispatch:", err);
          cmds = [];
        }
      }
      const tokenLower = parsedSlash.token.toLowerCase();
      const candidateHandler = resolveNativeHandler(parsedSlash.token);
      // Only same-name collisions shadow native dispatch. If the typed token
      // is a native alias, also honor a file-based command for the canonical
      // name — the user has replaced the whole native, so the alias should
      // route through the replacement too. If the typed token is the
      // canonical name, do NOT expand to aliases: a user `configure.md`
      // should not hijack `/config` when the canonical slot is still the
      // built-in.
      const shadowNames = new Set<string>([tokenLower]);
      if (candidateHandler) {
        const canonicalLower = candidateHandler.name.toLowerCase();
        const typedIsAlias = candidateHandler.aliases.some(
          (alias) => alias.toLowerCase() === tokenLower,
        );
        if (typedIsAlias) {
          shadowNames.add(canonicalLower);
        }
      }
      const shadowed = cmds.some(
        (c) =>
          (c.source === "user" || c.source === "project") &&
          shadowNames.has(c.name.toLowerCase()),
      );
      const nativeHandler = shadowed ? null : candidateHandler;
      if (nativeHandler) {
        const workspaceId = selectedWorkspaceId;
        const state = useAppStore.getState();
        const currentModel = state.selectedModel[sessionId] ?? "opus";
        const currentModelProvider = state.selectedModelProvider[sessionId] ?? "anthropic";
        const currentPermission: PermissionLevel =
          state.permissionLevel[sessionId] ?? "full";
        const currentPlanMode = state.planMode[sessionId] ?? false;
        const currentFastMode = state.fastMode[sessionId] ?? false;
        const currentThinking = state.thinkingEnabled[sessionId] ?? false;
        const currentChrome = state.chromeEnabled[sessionId] ?? false;
        const currentEffort = state.effortLevel[sessionId] ?? "auto";
        const planFilePath = findLatestPlanFilePath(sessionId);
        const agentStatusLabel =
          typeof ws.agent_status === "string"
            ? ws.agent_status
            : `Error: ${ws.agent_status.Error}`;
        const isRemoteWorkspace = !!ws.remote_connection_id;

        const addLocalMessage = (text: string) => {
          addChatMessage(
            sessionId,
            {
              id: crypto.randomUUID(),
              workspace_id: workspaceId,
              chat_session_id: sessionId,
              role: "System",
              content: text,
              cost_usd: null,
              duration_ms: null,
              created_at: new Date().toISOString(),
              thinking: null,
              input_tokens: null,
              output_tokens: null,
              cache_read_tokens: null,
              cache_creation_tokens: null,
            },
            { persisted: false },
          );
        };

        const setSelectedModelBound = (nextModel: string, providerId?: string) =>
          applySelectedModel(sessionId, nextModel, providerId ?? "anthropic");

        const setPermissionLevelBound = async (level: PermissionLevel) => {
          const previous =
            useAppStore.getState().permissionLevel[sessionId] ?? "full";
          useAppStore.getState().setPermissionLevel(sessionId, level);
          try {
            await setAppSetting(`permission_level:${sessionId}`, level);
          } catch (err) {
            useAppStore.getState().setPermissionLevel(sessionId, previous);
            throw err;
          }
        };

        const setPlanModeBound = (enabled: boolean) => {
          useAppStore.getState().setPlanMode(sessionId, enabled);
        };

        // Route plan-file reads through the remote server for remote
        // workspaces, matching the PlanApprovalCard's "View plan" dispatch.
        // Falls through to the local Tauri command for local workspaces.
        const remoteConnectionId = ws.remote_connection_id;
        const readPlanFileBound = remoteConnectionId
          ? async (path: string) =>
              (await sendRemoteCommand(remoteConnectionId, "read_plan_file", {
                path,
              })) as string
          : readPlanFile;

        const clearConversationBound = async (restoreFiles: boolean) => {
          // The /clear pipeline (clearConversation + follow-up reloads) runs
          // via local Tauri invokes only — RollbackModal has the same
          // boundary. Surface a clear local message on remote workspaces
          // rather than partially executing and leaving the UI in a
          // half-reset state.
          if (isRemoteWorkspace) {
            throw new Error(
              "/clear is not yet supported for remote workspaces",
            );
          }
          const store = useAppStore.getState();
          const messages = await clearConversation(sessionId, restoreFiles);
          store.rollbackConversation(sessionId, workspaceId, "__clear__", messages);
          loadCompletedTurns(sessionId)
            .then((turnData) => {
              const turns = reconstructCompletedTurns(messages, turnData);
              useAppStore.getState().setCompletedTurns(sessionId, turns);
            })
            .catch((err) =>
              console.error("Failed to reload turns after /clear:", err),
            );
          loadAttachmentsForSession(sessionId)
            .then((atts) =>
              useAppStore.getState().setChatAttachments(sessionId, atts),
            )
            .catch((err) =>
              console.error("Failed to reload attachments after /clear:", err),
            );
          useAppStore.getState().clearDiff();
          loadDiffFiles(workspaceId)
            .then((result) =>
              useAppStore
                .getState()
                .setDiffFiles(result.files, result.merge_base),
            )
            .catch((err) =>
              console.error("Failed to refresh diff after /clear:", err),
            );
        };

        const result = await nativeHandler.execute(
          {
            repoId: repo?.remote_connection_id ? null : repo?.id ?? null,
            pluginManagementEnabled,
            usageInsightsEnabled,
            openPluginSettings,
            repository: repo ? { name: repo.name, path: repo.path } : null,
            workspace: ws
              ? { branch: ws.branch_name, worktreePath: ws.worktree_path }
              : null,
            repoDefaultBranch: defaultBranch ?? null,
            openSettings,
            appVersion,
            addLocalMessage,
            openUsageSettingsExternal: () => {
              void openUsageSettings().catch((err) =>
                console.error("Failed to open usage settings:", err),
              );
            },
            openReleaseNotes: () => {
              void openReleaseNotes().catch((err) =>
                console.error("Failed to open release notes:", err),
              );
            },
            workspaceId,
            agentStatus: agentStatusLabel,
            selectedModel: currentModel,
            selectedModelProvider: currentModelProvider,
            permissionLevel: currentPermission,
            planMode: currentPlanMode,
            fastMode: currentFastMode,
            thinkingEnabled: currentThinking,
            chromeEnabled: currentChrome,
            effortLevel: currentEffort,
            planFilePath,
            setSelectedModel: setSelectedModelBound,
            setPermissionLevel: setPermissionLevelBound,
            setPlanMode: setPlanModeBound,
            clearConversation: clearConversationBound,
            readPlanFile: readPlanFileBound,
            slashCommands: cmds,
          },
          parsedSlash.args,
        );
        if (result.kind !== "skipped") {
          recordSlashCommandUsage(selectedWorkspaceId, result.canonicalName)
            .catch((nextError) => console.error("Failed to record slash command usage:", nextError));
        }
        if (result.kind === "handled") return;
        if (result.kind === "expand") {
          // Rewrite the outgoing content to the expanded prompt and fall through
          // to the normal agent send path (queue, optimistic message, stream).
          trimmed = result.prompt.trim();
          if (!trimmed) return;
        }
      }
    }

    // If the agent is running, queue the message instead of interrupting.
    // The user can press Escape to stop the agent if they want to interrupt.
    // Queued messages are auto-sent when the current turn finishes.
    if (isRunning) {
      setQueuedMessage(
        sessionId,
        trimmed,
        mentionedFilesArray,
        attachments,
      );
      return;
    }

    // Clear any pending agent question or plan approval — the user is sending
    // a new message (answer from a card or manual override).
    clearAgentQuestion(sessionId);
    clearPlanApproval(sessionId);

    setError(null);

    // Push to prompt history.
    const history = (historyRef.current[sessionId] ??= []);
    history.push(trimmed);
    historyIndexRef.current = -1;
    draftRef.current = "";
    const optimisticMsgId = crypto.randomUUID();
    addPersistedUserMessageToStore(sessionId, optimisticMsgId, trimmed, attachments);
    // Keep both the workspace aggregate AND the per-session status fresh.
    // The tab icon, sidebar badge, and ChatToolbar disable-state all read
    // session-level status; the workspace row still drives tray + unread.
    updateWorkspace(selectedWorkspaceId, { agent_status: "Running" });
    useAppStore.getState().setPromptStartTime(selectedWorkspaceId, Date.now());
    useAppStore.getState().updateChatSession(sessionId, {
      agent_status: "Running",
    });
    useAppStore.getState().clearUnreadCompletion(selectedWorkspaceId);

    try {
      if (ws?.remote_connection_id) {
        // Route to remote server via WebSocket.
        const state = useAppStore.getState();
        const selectedModel = state.selectedModel[sessionId] || null;
        const selectedProvider = state.selectedModelProvider[sessionId] || null;
        const disable1mContext = shouldDisable1mContext(selectedModel);
        const effort = resolveUltrathinkEffort(
          trimmed,
          state.effortLevel[sessionId],
        );
        await sendRemoteCommand(ws.remote_connection_id, "send_chat_message", {
          chat_session_id: sessionId,
          content: trimmed,
          mentioned_files: mentionedFilesArray,
          permission_level: permissionLevel,
          model: state.selectedModel[sessionId] || null,
          backend_id: selectedProvider,
          fast_mode: state.fastMode[sessionId] || false,
          thinking_enabled: state.thinkingEnabled[sessionId] || false,
          plan_mode: state.planMode[sessionId] || false,
          effort: effort ?? null,
          chrome_enabled: state.chromeEnabled[sessionId] || false,
          disable_1m_context: disable1mContext,
        });
      } else {
        const state = useAppStore.getState();
        const model = state.selectedModel[sessionId] || undefined;
        const backendId = state.selectedModelProvider[sessionId] || undefined;
        const fastMode = state.fastMode[sessionId] || false;
        const thinkingEnabled = state.thinkingEnabled[sessionId] || false;
        const planMode = state.planMode[sessionId] || false;
        const effort = resolveUltrathinkEffort(
          trimmed,
          state.effortLevel[sessionId],
        );
        const chromeEnabled = state.chromeEnabled[sessionId] || false;
        const disable1mContext = shouldDisable1mContext(model ?? null);
        await sendChatMessage(
          sessionId,
          trimmed,
          mentionedFilesArray,
          permissionLevel,
          model,
          fastMode || undefined,
          thinkingEnabled || undefined,
          planMode || undefined,
          effort,
          chromeEnabled || undefined,
          disable1mContext || undefined,
          backendId,
          attachments,
          optimisticMsgId,
        );
      }
    } catch (e) {
      const errMsg = String(e);
      console.error("sendChatMessage failed:", errMsg);
      setError(errMsg);
      updateWorkspace(selectedWorkspaceId, { agent_status: "Idle" });
      useAppStore.getState().clearPromptStartTime(selectedWorkspaceId);
    }
  };

  handleSendRef.current = handleSend;

  const handleStop = async () => {
    if (!activeSessionId || !selectedWorkspaceId) return;
    const sessionId = activeSessionId;
    // Clear queued message — stopping means the user wants to take control.
    clearQueuedMessage(sessionId);
    try {
      if (ws?.remote_connection_id) {
        await sendRemoteCommand(ws.remote_connection_id, "stop_agent", {
          chat_session_id: sessionId,
        });
      } else {
        await stopAgent(sessionId);
      }
      // Don't write workspace-level agent_status here: stop is per-session
      // and other sessions in the workspace may still be running. The
      // backend ProcessExited event flips this session to Stopped, and
      // useAgentStream re-derives the workspace aggregate from sessions.
    } catch (e) {
      console.error("stopAgent failed:", e);
    }
  };

  return (
    <div className={styles.panel}>
      <WorkspacePanelHeader />
      {selectedWorkspaceId && <SessionTabs workspaceId={selectedWorkspaceId} />}

      <div className={styles.messagesWrapper}>
        {selectedWorkspaceId && (
          <ChatSearchBar
            workspaceId={selectedWorkspaceId}
            scopeRef={messagesContainerRef}
          />
        )}
        <ScrollContext.Provider value={scrollContextValue}>
        {/* Custom DOM scrollbar overlay. Mirrors xterm.js / Monaco's
         * always-visible 8px slider so all three surfaces stay
         * pixel-identical at every browser zoom (the OS overlay
         * scrollbar that WKWebView would render on `.messages` instead
         * doesn't scale with zoom). */}
        <OverlayScrollbar targetRef={messagesContainerRef} />
        <div className={styles.messages} ref={messagesContainerRef}>
          <CliInvocationBanner
            invocation={cliInvocation}
            sessionId={activeChatSessionRecord?.id}
          />
          {messages.length === 0 && !hasStreaming ? (
            <div className={styles.empty}>
              Send a message to start a conversation
            </div>
          ) : (
            <>
              {isLoadingMore && (
                <div className={styles.loadingOlder}>
                  <LoaderCircle size={14} className={styles.loadingOlderSpinner} />
                  Loading older messages…
                </div>
              )}
              {activeSessionId && selectedWorkspaceId && (
                <MessagesWithTurns
                  messages={messages}
                  workspaceId={selectedWorkspaceId}
                  sessionId={activeSessionId}
                  isRunning={isRunning}
                  onForkTurn={isRemote ? undefined : handleFork}
                  onAttachmentContextMenu={openAttachmentMenu}
                  onAttachmentClick={openLightbox}
                  searchQuery={searchQuery}
                  globalOffset={globalOffset}
                  toolDisplayMode={toolDisplayMode}
                  liveTaskProgressNode={
                    activitiesCount > 0 ? (
                      <CurrentTurnTaskProgress sessionId={activeSessionId} />
                    ) : null
                  }
                  streamingThinkingNode={
                    hasThinking && showThinkingBlocks ? (
                      <StreamingThinkingBlock
                        sessionId={activeSessionId}
                        isStreaming={isRunning ?? false}
                        inline={toolDisplayMode === "inline"}
                        searchQuery={searchQuery}
                      />
                    ) : null
                  }
                  streamingMessageNode={
                    hasStreaming ? (
                      <StreamingMessage
                        sessionId={activeSessionId}
                        isStreaming={isRunning ?? false}
                        searchQuery={searchQuery}
                      />
                    ) : null
                  }
                />
              )}

              {pendingQuestion && (
                <AgentQuestionCard
                  question={pendingQuestion}
                  onRespond={async (answers) => {
                    if (!activeSessionId) return;
                    const sid = activeSessionId;
                    const toolUseId = pendingQuestion.toolUseId;
                    try {
                      await submitAgentAnswer(sid, toolUseId, answers);
                      clearAgentQuestion(sid);
                    } catch (e) {
                      console.error("Failed to submit agent answer:", e);
                      setError(String(e));
                    }
                  }}
                />
              )}

              {pendingPlan && (
                <PlanApprovalCard
                  approval={pendingPlan}
                  remoteConnectionId={ws?.remote_connection_id ?? undefined}
                  onRespond={async (approved, reason) => {
                    if (!activeSessionId) return;
                    const sid = activeSessionId;
                    const toolUseId = pendingPlan.toolUseId;
                    try {
                      await submitPlanApproval(sid, toolUseId, approved, reason);
                      clearPlanApproval(sid);
                      // User action is authoritative for ending the plan
                      // phase — flip planMode off so the next turn triggers
                      // drift detection (backend `session_exited_plan` covers
                      // this already, but clearing the UI state keeps the
                      // toolbar chip in sync).
                      setPlanMode(sid, false);
                    } catch (e) {
                      console.error("Failed to submit plan approval:", e);
                      setError(String(e));
                    }
                  }}
                />
              )}

              {isRunning && !pendingQuestion && !pendingPlan && (
                <div
                  ref={processingRef}
                  className={styles.processing}
                  role="status"
                  aria-label={
                    ws?.agent_status === "Compacting"
                      ? t("compacting_aria", { elapsed: formatElapsed(elapsed) })
                      : t("processing_aria", { elapsed: formatElapsed(elapsed) })
                  }
                >
                  <span className={styles.spinnerWrap} aria-hidden="true">
                    <span className={styles.spinner} />
                  </span>
                  {ws?.agent_status === "Compacting" && (
                    <span className={styles.compactingLabel}>{t("compacting_label")}</span>
                  )}
                  <span className={styles.elapsed}>{formatElapsed(elapsed)}</span>
                </div>
              )}

              {error && <div className={styles.errorBanner}>{error}</div>}
            </>
          )}
        </div>
      </ScrollContext.Provider>
      </div>

      <ScrollToBottomPill
        visible={!isAtBottom && messages.length > 0}
        onClick={scrollToBottom}
      />

      {queuedMessages.length > 0 && activeSessionId && (
        <div className={styles.queuedPopover}>
          <div className={styles.queuedPopoverHeader}>
            <span className={styles.queuedLabel}>
              {t("queued_label")} · {queuedMessages.length}
            </span>
            <button
              className={styles.queuedClearAll}
              onClick={() => clearQueuedMessage(activeSessionId)}
              title={t("clear_queue")}
              aria-label={t("clear_queue")}
            >
              {t("clear_queue")}
            </button>
          </div>
          <div className={styles.queuedList}>
            {queuedMessages.map((message) => {
              const content = message.content.trim();
              const fallback = message.attachments?.length
                ? message.attachments.map((attachment) => attachment.filename).join(", ")
                : t("queued_attachment_fallback");
              return (
                <div className={styles.queuedMessage} key={message.id}>
                  <span className={styles.queuedIcon} aria-hidden="true">
                    <CornerDownRight size={14} />
                  </span>
                  <span className={styles.queuedContent}>{content || fallback}</span>
                  {!ws?.remote_connection_id && (
                    <button
                      className={styles.queuedSteer}
                      onClick={() => handleSteerQueuedMessage(message.id)}
                      disabled={isSteeringQueued || !isRunning}
                      data-tooltip={steerQueuedTooltip}
                      aria-label={t("steer_queued")}
                    >
                      {isSteeringQueued ? (
                        <LoaderCircle size={14} className={styles.queuedSteerSpinner} />
                      ) : (
                        <SendHorizontal size={14} />
                      )}
                      <span>{t("steer_queued_short")}</span>
                    </button>
                  )}
                  <button
                    className={styles.queuedCancel}
                    onClick={() => removeQueuedMessage(activeSessionId, message.id)}
                    title={t("cancel_queued")}
                    aria-label={t("cancel_queued")}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ChatInputArea
        onSend={handleSend}
        onSendSteer={handleSendSteer}
        onSteerQueuedTop={handleSteerQueuedTop}
        onRunShellCommand={handleRunShellCommand}
        onStop={handleStop}
        isRunning={isRunning}
        workspaceEnvironmentPreparing={workspaceEnvironmentPreparing}
        isRemote={!!ws?.remote_connection_id}
        hasQueuedMessages={queuedMessages.length > 0}
        selectedWorkspaceId={selectedWorkspaceId!}
        sessionId={activeSessionId!}
        repoId={repo?.id}
        projectPath={repo?.path}
        historyRef={historyRef}
        historyIndexRef={historyIndexRef}
        draftRef={draftRef}
        onAttachmentContextMenu={openAttachmentMenu}
        onAttachmentClick={openLightbox}
      />
      {attachmentMenu && (() => {
        const mt = attachmentMenu.attachment.media_type;
        const labels = buildAttachmentMenuLabels(mt);
        // The browser-wrapper path renders bytes inside <img>, which is
        // broken for PDFs (and would be broken for any non-image type we
        // add later). Drop "Open in New Window" for non-images — left-
        // click already opens the PDF in the system default viewer.
        const isImage = mt.startsWith("image/");
        const withBytes = () =>
          ensureAttachmentBytes(
            attachmentMenu.attachment,
            attachmentMenu.attachmentId,
          );
        return (
          <AttachmentContextMenu
            x={attachmentMenu.x}
            y={attachmentMenu.y}
            onClose={() => setAttachmentMenu(null)}
            items={[
              {
                label: labels.download,
                onSelect: () => {
                  withBytes()
                    .then(downloadAttachment)
                    .catch((err) => console.error("Download failed:", err));
                },
              },
              {
                label: labels.copy,
                onSelect: () => {
                  withBytes()
                    .then(copyAttachmentToClipboard)
                    .catch((err) => console.error("Copy failed:", err));
                },
              },
              ...(isImage
                ? [
                    {
                      label: labels.open,
                      onSelect: () => {
                        withBytes()
                          .then(openAttachmentInBrowser)
                          .catch((err) =>
                            console.error("Open in browser failed:", err),
                          );
                      },
                    },
                  ]
                : [
                    // Non-image types (PDF + the text-shaped cards)
                    // route through the OS default-app handler — the
                    // Rust side stages the bytes to a temp file with
                    // the right extension and asks the system to open
                    // it. Same UX as left-clicking a PDF thumbnail.
                    {
                      label: "Open with default app",
                      onSelect: () => {
                        withBytes()
                          .then(openAttachmentWithDefaultApp)
                          .catch((err) =>
                            console.error("Open with default app failed:", err),
                          );
                      },
                    },
                  ]),
              ...(shareSupported
                ? [
                    {
                      label: "Share…",
                      onSelect: () => {
                        withBytes()
                          .then(shareAttachment)
                          .catch((err) => console.error("Share failed:", err));
                      },
                    },
                  ]
                : []),
            ]}
          />
        );
      })()}
      {lightbox && (
        <AttachmentLightbox
          attachment={lightbox.attachment}
          returnFocusTo={lightbox.returnFocus}
          onClose={() => setLightbox(null)}
          onContextMenu={(e) => openAttachmentMenu(e, lightbox.attachment)}
        />
      )}
    </div>
  );
}
