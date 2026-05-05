import type { StateCreator } from "zustand";
import type { AppState } from "../useAppStore";
import type { UnifiedTabEntry } from "../../components/chat/sessionTabsLogic";

// Per-workspace ordering for the unified workspace-tab strip (sessions /
// files / diffs interleaved). Volatile by design — not persisted across
// app restarts. On reload, only chat sessions come back (via their
// `chat_sessions.sort_order` column); files/diffs are not restored, so the
// initial unified order falls back to the default "sessions first" layout
// each session.
//
// The slice stores entries in the visual order the user dragged into. The
// SessionTabs component reconciles this with the live sessions/files/diffs
// state on every render: items in tabOrder that no longer exist drop out,
// and newly-opened tabs append at the end.

export interface TabOrderSlice {
  tabOrderByWorkspace: Record<string, UnifiedTabEntry[]>;
  setTabOrderForWorkspace: (
    workspaceId: string,
    entries: UnifiedTabEntry[],
  ) => void;
  /** Drop a workspace's saved tab order. Called when a workspace is removed
   *  so we don't leak stale UI state into the next workspace that reuses
   *  the id (rare but possible after restore-from-archive). */
  clearTabOrderForWorkspace: (workspaceId: string) => void;
}

export const createTabOrderSlice: StateCreator<
  AppState,
  [],
  [],
  TabOrderSlice
> = (set) => ({
  tabOrderByWorkspace: {},
  setTabOrderForWorkspace: (workspaceId, entries) =>
    set((s) => ({
      tabOrderByWorkspace: {
        ...s.tabOrderByWorkspace,
        [workspaceId]: entries,
      },
    })),
  clearTabOrderForWorkspace: (workspaceId) =>
    set((s) => {
      if (!(workspaceId in s.tabOrderByWorkspace)) return s;
      const next = { ...s.tabOrderByWorkspace };
      delete next[workspaceId];
      return { tabOrderByWorkspace: next };
    }),
});
