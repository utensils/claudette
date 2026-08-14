import { useEffect, useRef } from "react";
import { useAppStore } from "../../stores/useAppStore";

/**
 * Drains prompts queued for the active session via `enqueueChatPrompt`.
 *
 * `ChatPanel.handleSend` is bound to whichever session is active, so
 * anything that wants to "open a tab and run this prompt there" has to hand
 * the prompt off through the store and wait for that tab to become active.
 * This hook is the consumer side of that handoff.
 *
 * Mirrors `TerminalPanel`'s pending-command drain: a re-entrancy ref guards
 * against a second effect run dispatching the same entry while the first
 * `send` is still in flight, and each iteration re-reads the queue from
 * `getState()` so entries enqueued mid-drain are picked up.
 */
export function usePendingChatPrompt(
  activeSessionId: string | null,
  send: (content: string) => void | Promise<void>,
): void {
  const pendingChatPrompts = useAppStore((s) => s.pendingChatPrompts);
  const completeChatPrompt = useAppStore((s) => s.completeChatPrompt);

  // `send` closes over the whole ChatPanel render scope and is a new
  // function every render. Holding it in a ref keeps it out of the effect's
  // dependency list so a re-render mid-drain can't retrigger the effect.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const drainingRef = useRef(false);

  useEffect(() => {
    if (!activeSessionId) return;
    if (drainingRef.current) return;
    if (!pendingChatPrompts.some((p) => p.sessionId === activeSessionId)) return;

    drainingRef.current = true;
    // Pin the send function for the whole drain, alongside the
    // `activeSessionId` this effect closed over. Each render's `send`
    // dispatches into *that* render's active session, so re-reading
    // `sendRef.current` per iteration would pair a prompt dequeued for the
    // old session with a closure bound to whichever session the user
    // switched to mid-drain — delivering it into the wrong tab.
    const send = sendRef.current;
    void (async () => {
      while (true) {
        const queued = useAppStore
          .getState()
          .pendingChatPrompts.find((p) => p.sessionId === activeSessionId);
        if (!queued) break;
        // Dequeue *before* sending. `handleSend` is async and can re-render
        // the panel several times; leaving the entry in place until it
        // resolved would let a re-run of this effect dispatch it twice.
        completeChatPrompt(queued.id);
        try {
          await send(queued.prompt);
        } catch (err) {
          console.error("[chat] Failed to send queued prompt:", err);
        }
      }
    })().finally(() => {
      drainingRef.current = false;
    });
  }, [activeSessionId, pendingChatPrompts, completeChatPrompt]);
}
