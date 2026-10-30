import type { ChatMessage } from "../../types/chat";

/**
 * Resolve where a turn-anchored item (an agent attachment, a conclusion
 * card) should render in the loaded message window.
 *
 * Such items are persisted against the *user* message that triggered the
 * turn (FK-cascade-safe) but belong visually with that turn's *assistant*
 * message — the next Assistant message after the anchor.
 *
 * Returns a function mapping an anchor message id to the id to render
 * under:
 * - anchor is a loaded User message followed by an Assistant → that Assistant;
 * - anchor is missing / not loaded, and the window starts mid-turn (its first
 *   non-System row is an Assistant) → that carry-over Assistant;
 * - otherwise → the anchor itself (which won't render if it isn't loaded —
 *   intentional for items whose turn is fully out of view), or `null` for a
 *   null anchor.
 */
export function buildTurnAssistantRouter(
  messages: readonly ChatMessage[],
): (anchor: string | null) => string | null {
  // Single reverse pass: each User message maps to the nearest Assistant
  // message after it. O(n).
  const userToNextAssistant = new Map<string, string>();
  const loadedMessageIds = new Set<string>();
  let nextAssistantId: string | null = null;
  let firstAssistantInWindow: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    loadedMessageIds.add(m.id);
    if (m.role === "Assistant") {
      nextAssistantId = m.id;
      firstAssistantInWindow = m.id;
    } else if (m.role === "User" && nextAssistantId) {
      userToNextAssistant.set(m.id, nextAssistantId);
    }
  }
  // A page can begin with a System sentinel (e.g. a compaction marker)
  // before the carry-over assistant, so look past System rows rather than
  // checking messages[0].
  const firstNonSystem = messages.find((m) => m.role !== "System");
  const startsMidTurn = firstNonSystem?.role === "Assistant";

  return (anchor) => {
    if (anchor) {
      const routed = userToNextAssistant.get(anchor);
      if (routed) return routed;
    }
    if (
      (!anchor || !loadedMessageIds.has(anchor)) &&
      firstAssistantInWindow !== null &&
      startsMidTurn
    ) {
      return firstAssistantInWindow;
    }
    return anchor ?? null;
  };
}
