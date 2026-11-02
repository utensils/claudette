import {
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";

import { getAppSetting } from "../../services/tauri";
import { debugChat } from "../../utils/chatDebug";
import { usePreventScrollBounce } from "../../hooks/usePreventScrollBounce";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import { useChatHistoryLoader } from "./useChatHistoryLoader";
import { useChatScrollMemory } from "./useChatScrollMemory";
import type { useChatPanelStore } from "./useChatPanelStore";
import { useOlderMessagesPagination } from "./useOlderMessagesPagination";

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

  useChatHistoryLoader({
    activeSessionId,
    draftRef,
    historyIndexRef,
    historyRef,
    hydrateCompletedTurns,
    selectedWorkspaceId,
    setChatMessages,
    setChatPagination,
    setError,
  });

  // Scroll restore runs after the history-load effect in the same commit, and
  // its scroll listener is registered before the pagination listener so the
  // live offset is recorded before an older page is requested.
  const { rememberChatScrollPosition } = useChatScrollMemory({
    activeSessionId,
    activeSessionIdsKey,
    messagesContainerRef,
    restoringChatScrollSessionsRef,
    restoreScrollPosition,
    scrollToBottom,
  });

  useOlderMessagesPagination({
    activeSessionId,
    hasMore,
    historyRef,
    isLoadingMore,
    messagesContainerRef,
    oldestMessageId,
  });

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
