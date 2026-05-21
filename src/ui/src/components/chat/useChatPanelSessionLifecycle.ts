import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";

import {
  getAppSetting,
  listCheckpoints,
  loadChatHistoryPage,
  loadCompletedTurns,
  sendRemoteCommand,
} from "../../services/tauri";
import type { ChatAttachment, ChatMessage, ChatPaginationState } from "../../types";
import { debugChat } from "../../utils/chatDebug";
import { extractCompactionEvents } from "../../utils/compactionSentinel";
import { extractLatestCallUsage } from "../../utils/extractLatestCallUsage";
import { reconstructCompletedTurns } from "../../utils/reconstructTurns";
import { usePreventScrollBounce } from "../../hooks/usePreventScrollBounce";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import { useAppStore } from "../../stores/useAppStore";
import type { useChatPanelStore } from "./useChatPanelStore";

type ChatPanelStore = ReturnType<typeof useChatPanelStore>;

type UseChatPanelSessionLifecycleOptions = Pick<
  ChatPanelStore,
  | "activeSessionId"
  | "activeSessionIdsKey"
  | "activitiesCount"
  | "completedTurnsCount"
  | "hasMore"
  | "hasStreaming"
  | "hydrateCompletedTurns"
  | "isLoadingMore"
  | "isRunning"
  | "messages"
  | "oldestMessageId"
  | "pendingApproval"
  | "pendingPlan"
  | "pendingQuestion"
  | "selectedWorkspaceId"
  | "setChatMessages"
  | "setChatPagination"
  | "setPermissionLevel"
> & {
  draftRef: MutableRefObject<string>;
  historyIndexRef: MutableRefObject<number>;
  historyRef: MutableRefObject<Record<string, string[]>>;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  restoringChatScrollSessionsRef: MutableRefObject<Set<string>>;
  setError: Dispatch<SetStateAction<string | null>>;
};

export function useChatPanelSessionLifecycle({
  activeSessionId,
  activeSessionIdsKey,
  activitiesCount,
  completedTurnsCount,
  draftRef,
  hasMore,
  hasStreaming,
  historyIndexRef,
  historyRef,
  hydrateCompletedTurns,
  isLoadingMore,
  isRunning,
  messages,
  messagesContainerRef,
  oldestMessageId,
  pendingApproval,
  pendingPlan,
  pendingQuestion,
  restoringChatScrollSessionsRef,
  selectedWorkspaceId,
  setChatMessages,
  setChatPagination,
  setError,
  setPermissionLevel,
}: UseChatPanelSessionLifecycleOptions) {
  const chatScrollTopBySessionRef = useRef(new Map<string, number>());

  const {
    isAtBottom,
    scrollToBottom,
    restoreScrollPosition,
    handleContentChanged,
    markUserScrollIntent,
    suppressNextAutoScrollRef,
  } = useStickyScroll(messagesContainerRef);
  usePreventScrollBounce(messagesContainerRef);

  const scrollContextValue = useMemo(
    () => ({ handleContentChanged, suppressNextAutoScrollRef }),
    [handleContentChanged, suppressNextAutoScrollRef],
  );

  useEffect(() => {
    const activeSessionIds = new Set(
      activeSessionIdsKey ? activeSessionIdsKey.split("\0") : [],
    );
    for (const sessionId of chatScrollTopBySessionRef.current.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        chatScrollTopBySessionRef.current.delete(sessionId);
      }
    }
    for (const sessionId of restoringChatScrollSessionsRef.current.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        restoringChatScrollSessionsRef.current.delete(sessionId);
      }
    }
  }, [activeSessionIdsKey, restoringChatScrollSessionsRef]);

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
    const isCurrentHistoryLoad = () => {
      const state = useAppStore.getState();
      return (
        state.selectedWorkspaceId === selectedWorkspaceId &&
        state.selectedSessionIdByWorkspaceId[selectedWorkspaceId] === sessionId
      );
    };

    debugChat("ChatPanel", "load-history:start", {
      sessionId,
      isLocal,
      agentStatus: currentWs?.agent_status ?? null,
    });

    const onMessages = (
      msgs: ChatMessage[],
      attachments?: ChatAttachment[],
      pageState?: ChatPaginationState,
    ) => {
      if (cancelled || !isCurrentHistoryLoad()) return;
      const filtered = pageState
        ? msgs
        : msgs.filter(
            (m) => m.role !== "Assistant" || m.content.trim() !== "" || !!m.thinking,
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
      const loadGlobalOffset = pageState
        ? pageState.totalCount - filtered.length
        : 0;
      historyRef.current[sessionId] = filtered
        .filter((m) => m.role === "User")
        .map((m) => m.content);
      const callUsage = extractLatestCallUsage(filtered);
      const store = useAppStore.getState();
      if (callUsage) store.setLatestTurnUsage(sessionId, callUsage);
      else store.clearLatestTurnUsage(sessionId);
      store.setCompactionEvents(sessionId, extractCompactionEvents(filtered));

      if (isLocal) {
        const sessions =
          useAppStore.getState().sessionsByWorkspace[selectedWorkspaceId] ?? [];
        const thisSession = sessions.find((s) => s.id === sessionId);
        const sessionRunning = thisSession?.agent_status === "Running";
        debugChat("ChatPanel", "load-completed-turns:gate", {
          sessionId,
          isRunning: sessionRunning,
          currentCompletedTurnIds: (
            useAppStore.getState().completedTurns[sessionId] || []
          ).map((turn) => turn.id),
        });
        if (!sessionRunning) {
          loadCompletedTurns(sessionId)
            .then((turnData) => {
              if (cancelled || !isCurrentHistoryLoad()) return;
              const turns = reconstructCompletedTurns(
                filtered,
                turnData,
                loadGlobalOffset,
              );
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
      const existingPagination = useAppStore.getState().chatPagination[sessionId];
      if (existingPagination) {
        debugChat("ChatPanel", "load-history:skip-already-loaded", {
          sessionId,
          totalCount: existingPagination.totalCount,
        });
      } else {
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
          const msgs =
            (data as { messages?: ChatMessage[] })?.messages ??
            (data as ChatMessage[]);
          onMessages(msgs);
        })
        .catch((e) => console.error("Failed to load chat history:", e));
    }

    if (isLocal) {
      const setCheckpoints = useAppStore.getState().setCheckpoints;
      listCheckpoints(sessionId)
        .then((cps) => {
          if (cancelled || !isCurrentHistoryLoad()) return;
          setCheckpoints(sessionId, cps);
        })
        .catch((e) => console.error("Failed to load checkpoints:", e));
    }

    return () => {
      cancelled = true;
    };
  }, [
    activeSessionId,
    draftRef,
    historyIndexRef,
    historyRef,
    hydrateCompletedTurns,
    selectedWorkspaceId,
    setChatMessages,
    setChatPagination,
    setError,
  ]);

  useEffect(() => {
    if (!activeSessionId) return;
    const savedScrollTop = chatScrollTopBySessionRef.current.get(activeSessionId);
    if (savedScrollTop == null) {
      restoringChatScrollSessionsRef.current.delete(activeSessionId);
      scrollToBottom();
      return;
    }
    const restoringSessions = restoringChatScrollSessionsRef.current;
    restoringSessions.add(activeSessionId);
    let cancelled = false;
    let frameId: number | null = null;
    let attempts = 0;
    const restore = () => {
      if (cancelled) return;
      restoreScrollPosition(savedScrollTop);
      attempts += 1;
      const container = messagesContainerRef.current;
      const maxScrollTop = container
        ? Math.max(0, container.scrollHeight - container.clientHeight)
        : 0;
      const expectedTop = Math.min(savedScrollTop, maxScrollTop);
      if (
        attempts < 8 &&
        container &&
        Math.abs(container.scrollTop - expectedTop) > 1
      ) {
        frameId = requestAnimationFrame(restore);
      } else {
        restoringSessions.delete(activeSessionId);
      }
    };
    frameId = requestAnimationFrame(restore);
    return () => {
      cancelled = true;
      restoringSessions.delete(activeSessionId);
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [
    activeSessionId,
    messagesContainerRef,
    restoreScrollPosition,
    restoringChatScrollSessionsRef,
    scrollToBottom,
  ]);

  useEffect(() => {
    if (!activeSessionId) return;
    const container = messagesContainerRef.current;
    const scrollPositions = chatScrollTopBySessionRef.current;
    const restoringSessions = restoringChatScrollSessionsRef.current;
    return () => {
      if (container && !restoringSessions.has(activeSessionId)) {
        scrollPositions.set(activeSessionId, container.scrollTop);
        restoringSessions.add(activeSessionId);
      }
    };
  }, [activeSessionId, messagesContainerRef, restoringChatScrollSessionsRef]);

  const rememberChatScrollPosition = useCallback(() => {
    if (!activeSessionId) return;
    const container = messagesContainerRef.current;
    if (!container) return;
    chatScrollTopBySessionRef.current.set(activeSessionId, container.scrollTop);
    restoringChatScrollSessionsRef.current.add(activeSessionId);
  }, [activeSessionId, messagesContainerRef, restoringChatScrollSessionsRef]);

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
        activeSessionIdRef.current &&
        !restoringChatScrollSessionsRef.current.has(activeSessionIdRef.current)
      ) {
        chatScrollTopBySessionRef.current.set(
          activeSessionIdRef.current,
          container.scrollTop,
        );
      }
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

        isLoadingMoreRef.current = true;
        store.setChatPagination(sessionId, { ...pagination, isLoadingMore: true });
        const prevScrollHeight = container.scrollHeight;

        loadChatHistoryPage(sessionId, 50, cursorId)
          .then((page) => {
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
            const liveTotal =
              useAppStore.getState().chatPagination[sessionId]?.totalCount ?? 0;
            liveStore.setChatPagination(sessionId, {
              hasMore: page.has_more,
              isLoadingMore: false,
              totalCount: Math.max(page.total_count, liveTotal),
              oldestMessageId: page.messages[0]?.id ?? cursorId,
            });
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
            requestAnimationFrame(() => {
              container.scrollTop += container.scrollHeight - prevScrollHeight;
            });
            const merged = useAppStore.getState().chatMessages[sessionId] ?? [];
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
                useAppStore.getState().hydrateCompletedTurns(sessionId, turns);
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
            const live = useAppStore.getState().chatPagination[sessionId];
            if (!live) return;
            useAppStore
              .getState()
              .setChatPagination(sessionId, { ...live, isLoadingMore: false });
          })
          .finally(() => {
            isLoadingMoreRef.current = false;
          });
      }
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [activeSessionId, historyRef, messagesContainerRef, restoringChatScrollSessionsRef]);

  const prevMsgCountRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const sid = activeSessionId;
    if (!sid) return;
    const prev = prevMsgCountRef.current[sid] ?? 0;
    const cur = messages.length;
    prevMsgCountRef.current[sid] = cur;
    if (cur > prev) handleContentChanged();
  }, [messages.length, activeSessionId, handleContentChanged]);

  useEffect(() => {
    if (
      completedTurnsCount > 0 ||
      activitiesCount > 0 ||
      pendingQuestion ||
      pendingPlan ||
      pendingApproval
    ) {
      handleContentChanged();
    }
  }, [
    completedTurnsCount,
    activitiesCount,
    pendingQuestion,
    pendingPlan,
    pendingApproval,
    handleContentChanged,
  ]);

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

  return {
    isAtBottom,
    markUserScrollIntent,
    rememberChatScrollPosition,
    scrollContextValue,
    scrollToBottom,
  };
}
