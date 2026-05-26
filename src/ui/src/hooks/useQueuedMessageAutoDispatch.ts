import { useEffect, useRef } from "react";
import { dispatchChatMessage } from "../components/chat/chatMessageDispatch";
import { shouldAutoDispatchQueuedMessage } from "../components/chat/queuedMessageEditing";
import { useAppStore } from "../stores/useAppStore";
import type { AppState } from "../stores/useAppStore";

export function sessionIsRunning(state: AppState, sessionId: string): boolean | null {
  for (const sessions of Object.values(state.sessionsByWorkspace)) {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (session) return session.agent_status === "Running";
  }
  return null;
}

export function useQueuedMessageAutoDispatch() {
  const queuedMessages = useAppStore((s) => s.queuedMessages);
  const paused = useAppStore((s) => s.queuedMessageAutoDispatchPaused);
  const editing = useAppStore((s) => s.queuedMessageEditing);
  const steering = useAppStore((s) => s.queuedMessageSteering);
  const sessionsByWorkspace = useAppStore((s) => s.sessionsByWorkspace);
  const clearQueuedMessage = useAppStore((s) => s.clearQueuedMessage);
  const removeQueuedMessage = useAppStore((s) => s.removeQueuedMessage);
  const autoDispatchQueuedIdsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    const state = useAppStore.getState();
    for (const [sessionId, messages] of Object.entries(queuedMessages)) {
      const nextQueuedMessage = messages[0];
      const isRunning = sessionIsRunning(state, sessionId);
      if (isRunning === null) {
        clearQueuedMessage(sessionId);
        continue;
      }
      if (!shouldAutoDispatchQueuedMessage({
        isSteeringQueued: steering[sessionId] === true,
        isRunning,
        activeSessionId: sessionId,
        hasNextQueuedMessage: !!nextQueuedMessage,
        isEditingQueuedMessage: editing[sessionId] === true,
        isAutoDispatchPaused: paused[sessionId] === true,
        autoDispatchQueuedId: autoDispatchQueuedIdsRef.current[sessionId] ?? null,
      })) {
        continue;
      }

      const { id, content, mentionedFiles, attachments } = nextQueuedMessage;
      autoDispatchQueuedIdsRef.current[sessionId] = id;
      removeQueuedMessage(sessionId, id);
      queueMicrotask(() => {
        dispatchChatMessage({
          sessionId,
          content,
          mentionedFiles,
          attachments,
        }).catch((err) => {
          console.error("Queued message auto-dispatch failed:", err);
        }).finally(() => {
          const { [sessionId]: _, ...rest } = autoDispatchQueuedIdsRef.current;
          autoDispatchQueuedIdsRef.current = rest;
        });
      });
    }
  }, [
    queuedMessages,
    paused,
    editing,
    steering,
    sessionsByWorkspace,
    clearQueuedMessage,
    removeQueuedMessage,
  ]);
}
