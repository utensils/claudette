import type { StateCreator } from "zustand";
import type { AppState } from "../useAppStore";

/**
 * A prompt waiting to be sent into a specific chat session.
 *
 * Exists because `ChatPanel.handleSend` is bound to whichever session is
 * currently active — there is no way to hand it a prompt for a tab that
 * isn't mounted yet. Anything that wants to "open a tab and run this
 * there" (today: pinned prompts with `new_session`) enqueues here, and the
 * panel drains the queue once the target session is the active one.
 *
 * Deliberately routed through `handleSend` rather than the raw Tauri
 * command: slash-command dispatch, `@path` mention extraction, attachment
 * handling, and plan-mode all live in that path.
 */
export interface PendingChatPrompt {
  id: string;
  sessionId: string;
  prompt: string;
}

export interface PendingChatPromptsSlice {
  pendingChatPrompts: PendingChatPrompt[];
  /** Queue `prompt` for `sessionId`. Returns the queue entry id. */
  enqueueChatPrompt: (sessionId: string, prompt: string) => string;
  /** Drop a queue entry once it has been dispatched (or failed). */
  completeChatPrompt: (id: string) => void;
}

/**
 * Drop every entry targeting `sessionId`.
 *
 * Exported as a pure helper rather than a store action because the only
 * caller is `chatSessionsSlice.removeChatSession`, which already rebuilds
 * the whole per-session cleanup in a single `set()` — routing through an
 * action there would mean a second store notification for the same event.
 * Returns the original array when nothing matches so the caller can keep
 * its reference-stability guarantees.
 */
export function withoutPromptsForSession(
  prompts: PendingChatPrompt[],
  sessionId: string,
): PendingChatPrompt[] {
  if (!prompts.some((p) => p.sessionId === sessionId)) return prompts;
  return prompts.filter((p) => p.sessionId !== sessionId);
}

export const createPendingChatPromptsSlice: StateCreator<
  AppState,
  [],
  [],
  PendingChatPromptsSlice
> = (set) => ({
  pendingChatPrompts: [],

  enqueueChatPrompt: (sessionId, prompt) => {
    const id = crypto.randomUUID();
    set((s) => ({
      pendingChatPrompts: [...s.pendingChatPrompts, { id, sessionId, prompt }],
    }));
    return id;
  },

  completeChatPrompt: (id) =>
    set((s) => {
      // Return the untouched state for an unknown id. A fresh array here
      // would re-render every subscriber — including the drain effect,
      // which would then re-run for no reason.
      if (!s.pendingChatPrompts.some((p) => p.id === id)) return s;
      return {
        pendingChatPrompts: s.pendingChatPrompts.filter((p) => p.id !== id),
      };
    }),
});
