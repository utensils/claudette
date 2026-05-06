import type { ChatSession, DiffFileTab, DiffLayer } from "../../types";

// A unified entry in the workspace tab strip. SessionTabs renders sessions,
// diffs, and files as one ordered list; the user can drag any of them to
// any position. Persistence is asymmetric: chat sessions persist via
// `chat_sessions.sort_order`, while file/diff openness is volatile (per the
// 3A "volatile" decision). After a drop we need to (a) split the new
// unified order back into per-kind arrays and (b) compute which session
// `sort_order` values to write to the DB.
export type UnifiedTabEntry =
  | { kind: "session"; sessionId: string }
  | { kind: "diff"; path: string; layer: DiffLayer | null }
  | { kind: "file"; path: string };

export interface SplitTabOrder {
  sessions: ChatSession[];
  diffs: DiffFileTab[];
  files: string[];
  /** Session ids in the order they should be persisted via
   *  `reorder_chat_sessions`. See note on persistence semantics in
   *  `computeSessionPersistOrder` below. */
  sessionPersistIds: string[];
}

/**
 * Split a reordered unified entry list back into per-kind arrays.
 *
 * The unified `entries` array is the post-drop visual order. Lookups from
 * `currentSessions`, `currentDiffs`, `currentFiles` are needed because the
 * unified entries only carry ids/paths — we have to reattach the rich
 * objects (with their existing fields) for the per-kind state slots.
 */
export function splitUnifiedTabOrder(
  entries: readonly UnifiedTabEntry[],
  currentSessions: readonly ChatSession[],
  currentDiffs: readonly DiffFileTab[],
  currentFiles: readonly string[],
): SplitTabOrder {
  const sessionsById = new Map(currentSessions.map((s) => [s.id, s]));
  const diffsByKey = new Map(
    currentDiffs.map((d) => [`${d.path}\0${d.layer ?? ""}`, d]),
  );
  const fileSet = new Set(currentFiles);

  const sessions: ChatSession[] = [];
  const diffs: DiffFileTab[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.kind === "session") {
      const s = sessionsById.get(entry.sessionId);
      if (s) sessions.push(s);
    } else if (entry.kind === "diff") {
      const d = diffsByKey.get(`${entry.path}\0${entry.layer ?? ""}`);
      if (d) diffs.push(d);
    } else if (fileSet.has(entry.path)) {
      files.push(entry.path);
    }
  }

  return {
    sessions,
    diffs,
    files,
    sessionPersistIds: computeSessionPersistOrder(entries),
  };
}

/**
 * Compute the chat-session id sequence to persist via
 * `reorder_chat_sessions`. This is the meaningful business decision left to
 * the human: how should session sort_order relate to a unified strip that
 * includes non-persistent file/diff tabs?
 *
 * Three reasonable interpretations:
 *
 * (1) Dense-among-sessions: session sort_orders are 0..N-1 in the order
 *     sessions appear in the unified strip, ignoring intervening files/
 *     diffs. On reload (no files/diffs open) sessions appear in exactly
 *     the relative order the user dragged them into. This is the most
 *     "WYSIWYG-on-reload" option and matches how IDEs treat pinned vs.
 *     unpinned tabs as separate persisted lists.
 *
 * (2) Unified-index-anchored: each session's sort_order is its position
 *     in the full unified array (with gaps where files/diffs were). On
 *     reload sessions appear in the same relative order as (1) — the gaps
 *     are harmless because ORDER BY only sees session rows. So functionally
 *     equivalent to (1) but with non-dense values. No real upside; mostly
 *     here for completeness.
 *
 * (3) Frozen: don't write any session order on cross-kind drops; only
 *     persist session reorders that happen between two session tabs (no
 *     file/diff tab dragged-through). Most conservative; means dragging a
 *     file into the middle of sessions can't change session order even if
 *     the user later closes the file. Probably surprising to users.
 *
 * Default: option (1) "dense-among-sessions". Walk the unified order, pick
 * out session entries in the order they appear, and write that sequence to
 * `chat_sessions.sort_order`. On reload (no files/diffs persisted) sessions
 * appear in exactly the relative order the user dragged them into.
 *
 * Swap to (3) "frozen" by returning [] here and only writing when a real
 * session-vs-session move was committed; SessionTabs already skips the
 * Tauri call when this list is empty.
 */
export function computeSessionPersistOrder(
  entries: readonly UnifiedTabEntry[],
): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.kind === "session") out.push(e.sessionId);
  }
  return out;
}

export function closeScopeForTabContext<
  T extends { key: string; kind: UnifiedTabEntry["kind"] },
>(entries: readonly T[], targetKey: string): T[] {
  const target = entries.find((entry) => entry.key === targetKey);
  if (!target) return [];
  if (target.kind !== "file") return [...entries];
  return entries.filter((entry) => entry.kind === "file");
}
