import type { ChatMessage } from "../types/chat";

/**
 * A single compaction event reconstructed from the CLI's compact_boundary
 * emission (live) or from a persisted COMPACTION: sentinel system message
 * (on workspace reload).
 */
export interface CompactionEvent {
  timestamp: string;
  trigger: string;
  preTokens: number;
  postTokens: number;
  durationMs: number;
  afterMessageIndex: number;
}

const COMPACTION_PREFIX = "COMPACTION:";
const SYNTHETIC_PREFIX = "SYNTHETIC_SUMMARY:\n";

/** Build the sentinel string persisted in the chat_messages.content field
 *  when a compact_boundary event arrives. */
export function buildCompactionSentinel(input: {
  trigger: string;
  preTokens: number;
  postTokens: number;
  durationMs: number;
}): string {
  return `${COMPACTION_PREFIX}${input.trigger}:${input.preTokens}:${input.postTokens}:${input.durationMs}`;
}

/** Parse a COMPACTION:... sentinel string. Returns null for non-sentinel
 *  or malformed content (wrong field count, non-numeric token counts). */
export function parseCompactionSentinel(
  content: string,
): Omit<CompactionEvent, "timestamp" | "afterMessageIndex"> | null {
  if (!content.startsWith(COMPACTION_PREFIX)) return null;
  const rest = content.slice(COMPACTION_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 4) return null;
  const [trigger, preStr, postStr, durStr] = parts;
  if (!trigger) return null;
  const preTokens = Number(preStr);
  const postTokens = Number(postStr);
  const durationMs = Number(durStr);
  if (!Number.isFinite(preTokens)) return null;
  if (!Number.isFinite(postTokens)) return null;
  if (!Number.isFinite(durationMs)) return null;
  return { trigger, preTokens, postTokens, durationMs };
}

/** Build the sentinel for a synthetic pre-compaction summary. */
export function buildSyntheticSummarySentinel(body: string): string {
  return `${SYNTHETIC_PREFIX}${body}`;
}

/** Parse a SYNTHETIC_SUMMARY sentinel. Returns null if the content
 *  doesn't use the sentinel. */
export function parseSyntheticSummarySentinel(content: string): string | null {
  if (!content.startsWith(SYNTHETIC_PREFIX)) return null;
  return content.slice(SYNTHETIC_PREFIX.length);
}

/**
 * Scan a persisted chat-message list for COMPACTION: sentinels and
 * return the reconstructed CompactionEvent[] for the Zustand slice.
 * Called on workspace load to seed `compactionEvents[wsId]`.
 */
export function extractCompactionEvents(
  messages: ChatMessage[],
): CompactionEvent[] {
  const events: CompactionEvent[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "System") return;
    const parsed = parseCompactionSentinel(m.content);
    if (!parsed) return;
    events.push({
      ...parsed,
      timestamp: m.created_at,
      afterMessageIndex: i,
    });
  });
  return events;
}
