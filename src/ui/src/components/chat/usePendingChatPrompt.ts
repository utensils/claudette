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

  // Keyed by session rather than a single boolean for the whole hook.
  // `ChatPanelSessionView` stays mounted across session switches, so one
  // shared flag meant an in-flight drain for session A blocked the effect
  // run that should have started draining session B — and A's `finally`
  // only writes a ref, which triggers no render and therefore no retry, so
  // B's prompt sat queued indefinitely. Two sessions draining at once is
  // fine: their queue entries are disjoint and they dispatch into separate
  // agent subprocesses. (`TerminalPanel` solves the same problem with a
  // drain tick, but its queue isn't partitioned the way this one is, so it
  // has to serialize where we don't.)
  const drainingSessionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!activeSessionId) return;
    if (drainingSessionsRef.current.has(activeSessionId)) return;
    if (!pendingChatPrompts.some((p) => p.sessionId === activeSessionId)) return;

    const draining = drainingSessionsRef.current;
    draining.add(activeSessionId);
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
      draining.delete(activeSessionId);
    });
  }, [activeSessionId, pendingChatPrompts, completeChatPrompt]);
}
