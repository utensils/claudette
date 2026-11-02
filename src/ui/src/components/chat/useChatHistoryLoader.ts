import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import {
  listCheckpoints,
  loadAgentConclusionsForSession,
  loadChatHistoryPage,
  loadCompletedTurns,
  resolveStaleWorkflowActivities,
  sendRemoteCommand,
} from "../../services/tauri";
import type { ChatAttachment, ChatMessage, ChatPaginationState } from "../../types";
import { debugChat } from "../../utils/chatDebug";
import { extractCompactionEvents } from "../../utils/compactionSentinel";
import { extractLatestCallUsage } from "../../utils/extractLatestCallUsage";
import { reconstructCompletedTurns } from "../../utils/reconstructTurns";
import { useAppStore } from "../../stores/useAppStore";
import type { useChatPanelStore } from "./useChatPanelStore";

type ChatPanelStore = ReturnType<typeof useChatPanelStore>;

export type UseChatHistoryLoaderOptions = Pick<
  ChatPanelStore,
  | "activeSessionId"
  | "hydrateCompletedTurns"
  | "selectedWorkspaceId"
  | "setChatMessages"
  | "setChatPagination"
> & {
  draftRef: MutableRefObject<string>;
  historyIndexRef: MutableRefObject<number>;
  historyRef: MutableRefObject<Record<string, string[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
};

/**
 * Loads the transcript for the active session whenever it (or the selected
 * workspace) changes: the first history page (local) or full history
 * (remote), completed turns, agent conclusions, and checkpoints. Also resets
 * the composer's prompt-history cursor and draft for the new session.
 */
export function useChatHistoryLoader({
  activeSessionId,
  draftRef,
  historyIndexRef,
  historyRef,
  hydrateCompletedTurns,
  selectedWorkspaceId,
  setChatMessages,
  setChatPagination,
  setError,
}: UseChatHistoryLoaderOptions): void {
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
          // Sweep before reading, so the turns we hydrate already carry the
          // resolved status. A `Workflow` row wedged by a previous app
          // session otherwise renders its status pill again on every load —
          // the boot sweep is the only other thing that clears it, so a
          // webview reload would not. Rust re-checks liveness and no-ops when
          // the session still has a CLI process; a failure here is not worth
          // blocking the transcript over, so it degrades to "load anyway".
          resolveStaleWorkflowActivities(sessionId)
            .catch((e) => {
              debugChat("ChatPanel", "resolve-stale-workflows:failed", {
                sessionId,
                error: String(e),
              });
              return 0;
            })
            .then(() => loadCompletedTurns(sessionId))
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
        // Agent-presented conclusions persist in their own table; load them
        // alongside history so the inline conclusion cards survive reload.
        // Live conclusions append separately via `agent-conclusion-created`.
        // Gated on the experimental "Claudette MCP" flag so the feature stays
        // fully dark when off (no card renders, even for past conclusions).
        if (useAppStore.getState().claudetteMcpEnabled) {
          loadAgentConclusionsForSession(sessionId)
            .then((conclusions) => {
              if (cancelled || !isCurrentHistoryLoad()) return;
              useAppStore.getState().setChatConclusions(sessionId, conclusions);
            })
            .catch((e) => console.error("Failed to load conclusions:", e));
        }
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
}
