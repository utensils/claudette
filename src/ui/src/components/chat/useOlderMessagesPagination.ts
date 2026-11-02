import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";

import { loadChatHistoryPage, loadCompletedTurns } from "../../services/tauri";
import { reconstructCompletedTurns } from "../../utils/reconstructTurns";
import { useAppStore } from "../../stores/useAppStore";

export interface UseOlderMessagesPaginationOptions {
  activeSessionId: string | null;
  hasMore: boolean;
  historyRef: MutableRefObject<Record<string, string[]>>;
  isLoadingMore: boolean;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  oldestMessageId: string | null;
}

/**
 * Pages in older chat messages when the transcript is scrolled near the top,
 * prepending them to the store while keeping the viewport anchored, and
 * re-hydrating completed turns against the merged message list.
 */
export function useOlderMessagesPagination({
  activeSessionId,
  hasMore,
  historyRef,
  isLoadingMore,
  messagesContainerRef,
  oldestMessageId,
}: UseOlderMessagesPaginationOptions): void {
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
  }, [activeSessionId, historyRef, messagesContainerRef]);
}
