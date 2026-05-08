import type { ChatSession, DiffFileTab, DiffLayer } from "../../types";

// A unified entry in the workspace tab strip. SessionTabs renders sessions,
// diffs, and files as one ordered list; the user can drag any of them to
// any position. Persistence is asymmetric: chat sessions persist via
// `chat_sessions.sort_order`, while file/diff tab identities and visual order
// persist in view state and lazily reload after restart. After a drop we need
// to (a) split the new unified order back into per-kind arrays and (b) compute
// which session `sort_order` values to write to the DB.
export type UnifiedTabEntry =
  | { kind: "session"; sessionId: string }
  | { kind: "diff"; path: string; layer: DiffLayer | null }
  | { kind: "file"; path: string };

// A `NavEntry` is a `UnifiedTabEntry` enriched with a stable `key` derived
// from its identity. The key namespace is shared with the in-component refs
// used for arrow-key focus, so cycling logic, ref maps, and `aria-selected`
// state all agree on which tab is "this" tab.
export type NavEntry =
  | { key: string; kind: "session"; sessionId: string }
  | { key: string; kind: "diff"; path: string; layer: DiffLayer | null }
  | { key: string; kind: "file"; path: string };

// Unified key namespace used by the tab strip's keyboard nav, ref map, and
// the cycle-tabs hotkey handler. Encoding the kind in the key keeps the
// navigation flat and ergonomic without leaking the underlying data shape.
// Kept verbatim from the original definitions in SessionTabs so existing
// in-component refs continue to resolve.
export const sessionNavKey = (id: string) => `s:${id}`;
export const diffNavKey = (path: string, layer: DiffLayer | null) =>
  `d:${path}:${layer ?? "null"}`;
export const fileNavKey = (path: string) => `f:${path}`;

/** Build the visible left-to-right tab order for a workspace, layered as
 *  sessions → diffs → files by default but honoring any saved unified order
 *  from drag-reorder. Newly-opened tabs (not yet in the saved order) append
 *  at the end so they don't disappear into the abyss. */
export function buildWorkspaceTabNavEntries(args: {
  activeSessions: readonly ChatSession[];
  diffTabs: readonly DiffFileTab[];
  fileTabs: readonly string[];
  tabOrder: readonly UnifiedTabEntry[] | undefined;
}): NavEntry[] {
  const { activeSessions, diffTabs, fileTabs, tabOrder } = args;
  const sessionEntries: NavEntry[] = activeSessions.map((s) => ({
    key: sessionNavKey(s.id),
    kind: "session",
    sessionId: s.id,
  }));
  const diffEntries: NavEntry[] = diffTabs.map((t) => ({
    key: diffNavKey(t.path, t.layer),
    kind: "diff",
    path: t.path,
    layer: t.layer,
  }));
  const fileEntries: NavEntry[] = fileTabs.map((p) => ({
    key: fileNavKey(p),
    kind: "file",
    path: p,
  }));
  const defaultOrder = [...sessionEntries, ...diffEntries, ...fileEntries];

  if (!tabOrder || tabOrder.length === 0) return defaultOrder;

  // Reconcile saved unified order with the live per-kind state. A small
  // map keyed by NavEntry.key lets us O(1) resolve each saved entry; new
  // tabs (not yet in the saved order) append at the end, preserving the
  // user's drag intent for everything they touched.
  const byKey = new Map(defaultOrder.map((e) => [e.key, e]));
  const out: NavEntry[] = [];
  const used = new Set<string>();
  for (const ord of tabOrder) {
    const key =
      ord.kind === "session"
        ? sessionNavKey(ord.sessionId)
        : ord.kind === "diff"
          ? diffNavKey(ord.path, ord.layer)
          : fileNavKey(ord.path);
    const entry = byKey.get(key);
    if (entry && !used.has(key)) {
      out.push(entry);
      used.add(key);
    }
  }
  for (const e of defaultOrder) {
    if (!used.has(e.key)) out.push(e);
  }
  return out;
}

/** Resolve which entry in the unified strip is currently "active" (the one
 *  the workspace's main pane is rendering). Mirrors the precedence used by
 *  AppLayout: an active file tab wins, then diff selection, then the
 *  selected chat session. Returns `null` when there's no active entry — for
 *  the cycle-tabs hotkey, the caller treats that as "start at the first
 *  entry on next, last on prev." */
export function findActiveNavEntryKey(args: {
  selectedSessionId: string | null;
  diffSelectedFile: string | null;
  diffSelectedLayer: DiffLayer | null;
  activeFileTab: string | null;
}): string | null {
  const { selectedSessionId, diffSelectedFile, diffSelectedLayer, activeFileTab } = args;
  if (activeFileTab !== null) return fileNavKey(activeFileTab);
  if (diffSelectedFile !== null) return diffNavKey(diffSelectedFile, diffSelectedLayer);
  if (selectedSessionId !== null) return sessionNavKey(selectedSessionId);
  return null;
}

/** Pure cycle helper. Returns the entry the caller should activate next, or
 *  `null` if cycling is a no-op (empty / single-tab strip).
 *
 *  When no entry is currently active (`activeKey === null`), `next` lands on
 *  index 0 and `prev` lands on the last entry — symmetric with how Chrome,
 *  VS Code, and most tabbed apps treat "no current tab." */
export function cycleNavEntries(
  entries: readonly NavEntry[],
  activeKey: string | null,
  direction: "prev" | "next",
): NavEntry | null {
  if (entries.length === 0) return null;
  if (entries.length === 1) return entries[0];
  const idx = activeKey ? entries.findIndex((e) => e.key === activeKey) : -1;
  if (idx < 0) return direction === "next" ? entries[0] : entries[entries.length - 1];
  const target =
    direction === "next"
      ? (idx + 1) % entries.length
      : (idx - 1 + entries.length) % entries.length;
  return entries[target];
}

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
 * includes file/diff tabs whose identities are restored from view state?
 *
 * Three reasonable interpretations:
 *
 * (1) Dense-among-sessions: session sort_orders are 0..N-1 in the order
 *     sessions appear in the unified strip, ignoring intervening files/
 *     diffs. On reload, sessions appear in exactly the relative order the user
 *     dragged them into, and restored file/diff tabs keep their separate view
 *     state order.
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
 * `chat_sessions.sort_order`. The full unified order is persisted separately
 * in view state.
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
>(
  entries: readonly T[],
  targetKey: string,
  includeInFileScope: (entry: T) => boolean = () => false,
): T[] {
  const target = entries.find((entry) => entry.key === targetKey);
  if (!target) return [];
  if (target.kind !== "file") return [...entries];
  return entries.filter(
    (entry) => entry.kind === "file" || includeInFileScope(entry),
  );
}
