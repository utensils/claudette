import type { ChatSession } from "../../types";

/** Return a new sessionsByWorkspace map with `needs_attention` / `attention_kind`
 *  cleared for the given session id. Returns the original map when the session
 *  isn't found so callers can compare referential equality. */
export function clearSessionAttention(
  map: Record<string, ChatSession[]>,
  sessionId: string,
): Record<string, ChatSession[]> {
  for (const [wsId, sessions] of Object.entries(map)) {
    const idx = sessions.findIndex((s) => s.id === sessionId);
    if (idx >= 0) {
      const updated = [...sessions];
      updated[idx] = {
        ...updated[idx],
        needs_attention: false,
        attention_kind: null,
      };
      return { ...map, [wsId]: updated };
    }
  }
  return map;
}
