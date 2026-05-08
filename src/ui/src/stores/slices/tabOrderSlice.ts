import type { StateCreator } from "zustand";
import type { AppState } from "../useAppStore";
import {
  buildWorkspaceTabNavEntries,
  cycleNavEntries,
  findActiveNavEntryKey,
  type UnifiedTabEntry,
} from "../../components/chat/sessionTabsLogic";

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
  /** Move the active selection in the workspace's unified tab strip
   *  (sessions / diffs / files) one slot in `direction`, with wrap-around.
   *  No-op when no workspace is selected or the strip has fewer than two
   *  entries. Used by the global Cmd/Ctrl+Shift+[/] hotkey, which
   *  previously cycled across workspaces — that responsibility moved to the
   *  sidebar / fuzzy finder once the unified tab strip subsumed multiple
   *  per-workspace surfaces and tab navigation became the higher-frequency
   *  intent. */
  cycleWorkspaceTab: (direction: "prev" | "next") => void;
}

export const createTabOrderSlice: StateCreator<
  AppState,
  [],
  [],
  TabOrderSlice
> = (set, get) => ({
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
  cycleWorkspaceTab: (direction) => {
    // Read the live snapshot once; every downstream call is dispatched
    // through `get()` so we never accidentally close over a stale slice.
    const state = get();
    const workspaceId = state.selectedWorkspaceId;
    if (!workspaceId) return;

    const activeSessions = (state.sessionsByWorkspace[workspaceId] ?? []).filter(
      (s) => s.status === "Active",
    );
    const diffTabs = state.diffTabsByWorkspace[workspaceId] ?? [];
    const fileTabs = state.fileTabsByWorkspace[workspaceId] ?? [];
    const tabOrder = state.tabOrderByWorkspace[workspaceId];

    const entries = buildWorkspaceTabNavEntries({
      activeSessions,
      diffTabs,
      fileTabs,
      tabOrder,
    });
    if (entries.length <= 1) return;

    const activeKey = findActiveNavEntryKey({
      selectedSessionId: state.selectedSessionIdByWorkspaceId[workspaceId] ?? null,
      diffSelectedFile: state.diffSelectedFile,
      diffSelectedLayer: state.diffSelectedLayer,
      activeFileTab: state.activeFileTabByWorkspace[workspaceId] ?? null,
    });

    const target = cycleNavEntries(entries, activeKey, direction);
    if (!target) return;

    // Mirror the orchestration in SessionTabs.navigateTabs: a non-file
    // selection has to clear the active file tab so the chat / diff pane
    // visually wins (AppLayout prioritizes the file viewer whenever a file
    // tab is active).
    if (target.kind === "session") {
      get().clearActiveFileTab(workspaceId);
      get().selectSession(workspaceId, target.sessionId);
    } else if (target.kind === "diff") {
      get().clearActiveFileTab(workspaceId);
      get().selectDiffTab(target.path, target.layer);
    } else {
      get().selectFileTab(workspaceId, target.path);
    }
  },
});
