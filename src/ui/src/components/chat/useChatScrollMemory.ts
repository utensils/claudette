import {
  useCallback,
  useEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from "react";

export interface UseChatScrollMemoryOptions {
  activeSessionId: string | null;
  /** `\0`-joined ids of every live session; positions for others are pruned. */
  activeSessionIdsKey: string;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  /**
   * Sessions whose scroll position is being restored (or is about to be).
   * While a session is in this set, scroll events must not overwrite its
   * remembered position — the restore loop's own programmatic scrolls (and
   * the container emptying out during a switch) would otherwise clobber it.
   * Shared with ChatPanel so other code paths can join the handshake.
   */
  restoringChatScrollSessionsRef: MutableRefObject<Set<string>>;
  restoreScrollPosition: (scrollTop: number) => void;
  scrollToBottom: () => void;
}

/**
 * Remembers each chat session's scroll offset and restores it when the
 * session becomes active again; sessions with no remembered offset snap to
 * the bottom instead.
 */
export function useChatScrollMemory({
  activeSessionId,
  activeSessionIdsKey,
  messagesContainerRef,
  restoringChatScrollSessionsRef,
  restoreScrollPosition,
  scrollToBottom,
}: UseChatScrollMemoryOptions) {
  const chatScrollTopBySessionRef = useRef(new Map<string, number>());

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

  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;

  // Track the live offset on every user/programmatic scroll. Registered
  // before the pagination listener (see `useOlderMessagesPagination`) so the
  // offset is recorded before an older page is requested — matching the
  // original single-listener ordering.
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
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [activeSessionId, messagesContainerRef, restoringChatScrollSessionsRef]);

  return { rememberChatScrollPosition };
}
