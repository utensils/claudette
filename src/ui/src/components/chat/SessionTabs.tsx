import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { FileDiff as FileDiffIcon, Plus, X } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import {
  fileBufferKey,
  isFileTabDirty,
} from "../../stores/slices/fileTreeSlice";
import {
  listChatSessions,
  createChatSession,
  renameChatSession,
  archiveChatSession,
  reorderChatSessions,
} from "../../services/tauri";
import { useTabDragReorder } from "../../hooks/useTabDragReorder";
import { TabDragGhost } from "../shared/TabDragGhost";
import { splitUnifiedTabOrder } from "./sessionTabsLogic";
import { SessionStatusIcon, type SessionStatusKind } from "../shared/SessionStatusIcon";
import {
  AttachmentContextMenu,
  type AttachmentContextMenuItem,
} from "./AttachmentContextMenu";
import { DiscardUnsavedChangesConfirm } from "../files/DiscardUnsavedChangesConfirm";
import { getFileIcon } from "../../utils/fileIcons";
import { createSerialGate } from "../../utils/serialGate";
import type { ChatSession, DiffFileTab, DiffLayer } from "../../types";
import styles from "./SessionTabs.module.css";

type NavDirection = "prev" | "next" | "first" | "last";

// Unified key namespace for the tab strip's keyboard nav and ref map.
// Sessions, diff tabs, and file tabs occupy a single ordered list;
// encoding the kind in the key keeps the navigation logic flat without
// touching the underlying data shapes.
const sessionNavKey = (id: string) => `s:${id}`;
const diffNavKey = (path: string, layer: DiffLayer | null) =>
  `d:${path}:${layer ?? "null"}`;
const fileNavKey = (path: string) => `f:${path}`;

interface Props {
  workspaceId: string;
}

function statusFor(session: ChatSession): SessionStatusKind {
  if (session.needs_attention) {
    return session.attention_kind === "Plan" ? { kind: "plan" } : { kind: "ask" };
  }
  if (session.agent_status === "Running") return { kind: "running" };
  return { kind: "idle" };
}

// Stable empty array so the selector doesn't return a new `[]` each call when
// this workspace has no sessions loaded yet. `useSyncExternalStore` compares
// consecutive snapshots with `Object.is` and forces a re-render on mismatch;
// a fresh `[]` every call turns that into an infinite render loop.
const EMPTY_SESSIONS: ChatSession[] = [];
const EMPTY_DIFF_TABS: DiffFileTab[] = [];
const EMPTY_FILE_TABS: string[] = [];

export function SessionTabs({ workspaceId }: Props) {
  const { t } = useTranslation("chat");
  const sessions = useAppStore(
    (s) => s.sessionsByWorkspace[workspaceId] ?? EMPTY_SESSIONS,
  );
  const selectedSessionId = useAppStore(
    (s) => s.selectedSessionIdByWorkspaceId[workspaceId] ?? null,
  );
  const diffTabs = useAppStore(
    (s) => s.diffTabsByWorkspace[workspaceId] ?? EMPTY_DIFF_TABS,
  );
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile);
  const diffSelectedLayer = useAppStore((s) => s.diffSelectedLayer);
  const fileTabs = useAppStore(
    (s) => s.fileTabsByWorkspace[workspaceId] ?? EMPTY_FILE_TABS,
  );
  const activeFileTab = useAppStore(
    (s) => s.activeFileTabByWorkspace[workspaceId] ?? null,
  );
  const setSessionsForWorkspace = useAppStore((s) => s.setSessionsForWorkspace);
  const addChatSession = useAppStore((s) => s.addChatSession);
  const updateChatSession = useAppStore((s) => s.updateChatSession);
  const removeChatSession = useAppStore((s) => s.removeChatSession);
  const selectSession = useAppStore((s) => s.selectSession);
  const selectDiffTab = useAppStore((s) => s.selectDiffTab);
  const closeDiffTab = useAppStore((s) => s.closeDiffTab);
  const selectFileTab = useAppStore((s) => s.selectFileTab);
  const closeFileTab = useAppStore((s) => s.closeFileTab);
  const clearActiveFileTab = useAppStore((s) => s.clearActiveFileTab);

  // Clearing the active file tab is what makes the chat/diff tab visually
  // "win" — `AppLayout` prioritizes the file viewer whenever a workspace
  // has an active file tab, so we have to explicitly deactivate it when
  // the user wants to go back to chat or diff. Wrap the underlying slice
  // actions so every chat/diff selection path (click, keyboard nav,
  // session create) clears the file selection in lockstep.
  const switchToSession = useCallback(
    (sessionId: string) => {
      clearActiveFileTab(workspaceId);
      selectSession(workspaceId, sessionId);
    },
    [clearActiveFileTab, selectSession, workspaceId],
  );
  const switchToDiff = useCallback(
    (path: string, layer: DiffLayer | null) => {
      clearActiveFileTab(workspaceId);
      selectDiffTab(path, layer);
    },
    [clearActiveFileTab, selectDiffTab, workspaceId],
  );

  // Per-instance dirty-close prompt: when the user closes one or more file
  // tabs with unsaved edits, we route through this state instead of
  // dispatching closeFileTab directly. A list (rather than a single path)
  // is required so bulk-close paths ("Close all", "Close others",
  // "Close to the right") can confirm every dirty tab in one prompt
  // instead of overwriting the slot per iteration. Confirming closes the
  // whole batch; cancelling leaves the tabs intact.
  const [pendingClosePaths, setPendingClosePaths] = useState<string[]>([]);

  // Monotonic version token: each local mutation (create/archive) bumps this so
  // an in-flight `listChatSessions` response can detect it's stale and skip the
  // overwrite. Without this, a create+archive that races with the initial load
  // can get stomped by the older snapshot.
  const loadVersionRef = useRef(0);

  // Defang rapid clicks on the "+ new session" button. Without the gate, a
  // user mashing the button while `createChatSession` is in flight would
  // queue every click as a separate tab once the backend caught up.
  // Issue 574 made this trivial to repro because the streaming task
  // could starve the create command for the duration of an entire turn.
  // We keep both pieces of state because each is load-bearing:
  //  - `gateRef` is the synchronous source of truth (a `useState` setter
  //    only takes effect after the next render, so two clicks in the same
  //    tick would both observe `false`).
  //  - `creating` drives the disabled prop / aria-busy on the button so
  //    the user gets immediate visual feedback.
  const gateRef = useRef(createSerialGate());
  const [creating, setCreating] = useState(false);

  // Load sessions for this workspace on mount / workspace change.
  useEffect(() => {
    const version = ++loadVersionRef.current;
    listChatSessions(workspaceId, false)
      .then((sessions) => {
        if (version === loadVersionRef.current) {
          setSessionsForWorkspace(workspaceId, sessions);
        }
      })
      .catch((err) => {
        console.error("[SessionTabs] Failed to load sessions:", err);
      });
  }, [workspaceId, setSessionsForWorkspace]);

  // Memoized so navEntries / navigateTabs stay referentially stable when the
  // session list hasn't changed — without this, `sessions.filter` returns a
  // fresh array each render and defeats the downstream useMemo/useCallback.
  const activeSessions = useMemo(
    () => sessions.filter((s) => s.status === "Active"),
    [sessions],
  );

  const handleCreate = async () => {
    // Drive `setCreating` from inside the gated callback so it only fires
    // for the call that actually acquires the gate. If a second click
    // somehow slipped past the synchronous `isPending()` check, gate.run
    // would return `null` immediately for it and that caller wouldn't
    // touch the visual state — leaving the in-flight call's `creating=true`
    // intact for the duration of the real request.
    try {
      const session = await gateRef.current.run(async () => {
        setCreating(true);
        try {
          return await createChatSession(workspaceId);
        } finally {
          setCreating(false);
        }
      });
      if (session !== null) {
        // Invalidate any in-flight load — our local addChatSession is authoritative.
        loadVersionRef.current += 1;
        addChatSession(session);
        switchToSession(session.id);
      }
    } catch (err) {
      console.error("[SessionTabs] Failed to create session:", err);
    }
  };

  const archiveSessionImmediate = useCallback(
    async (session: ChatSession) => {
      try {
        const autoCreated = await archiveChatSession(session.id);
        loadVersionRef.current += 1;
        removeChatSession(session.id);
        if (autoCreated) {
          addChatSession(autoCreated);
          // Only navigate to the new session when the diff panel isn't active —
          // bulk-closing sessions while a diff tab is focused should leave the
          // diff view undisturbed.
          if (useAppStore.getState().diffSelectedFile === null) {
            selectSession(workspaceId, autoCreated.id);
          }
        }
      } catch (err) {
        console.error("[SessionTabs] Failed to archive session:", err);
      }
    },
    [removeChatSession, addChatSession, selectSession, workspaceId],
  );

  const handleArchive = async (session: ChatSession) => {
    if (session.agent_status === "Running") {
      const ok = window.confirm(
        t("session_running_confirm_close", { name: session.name }),
      );
      if (!ok) return;
    }
    await archiveSessionImmediate(session);
  };

  // Refs keyed by a unified nav key (sessionNavKey / diffNavKey) so arrow-key
  // navigation can focus any tab in the strip, regardless of kind.
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const setFileTabsForWorkspace = useAppStore((s) => s.setFileTabsForWorkspace);
  const setDiffTabsForWorkspace = useAppStore((s) => s.setDiffTabsForWorkspace);

  // Unified ordered list of focusable tab entries. Sessions first, diffs
  // second — the layout users see in the strip. Wrapped in useMemo so the
  // navigateTabs callback identity stays stable across unrelated re-renders.
  type NavEntry =
    | { key: string; kind: "session"; sessionId: string }
    | { key: string; kind: "diff"; path: string; layer: DiffLayer | null }
    | { key: string; kind: "file"; path: string };
  const navEntries = useMemo<NavEntry[]>(() => {
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
    return [...sessionEntries, ...diffEntries, ...fileEntries];
  }, [activeSessions, diffTabs, fileTabs]);

  // Drag-reorder over the unified strip. The hook is generic over an `Id`
  // type — we use the unified nav key (`s:`/`d:`/`f:` prefix) as the
  // identifier so chat sessions, diffs, and files share one drag namespace.
  // On drop we split the new order back into three lists, push the volatile
  // file/diff arrays to the store, and persist session sort_order via the
  // backend.
  const navEntryByKey = useMemo(() => {
    const m = new Map<string, NavEntry>();
    for (const e of navEntries) m.set(e.key, e);
    return m;
  }, [navEntries]);

  const tabReorder = useTabDragReorder<NavEntry, string>({
    items: navEntries,
    dataAttr: "sessionTabKey",
    parseId: (raw) => raw,
    getId: (e) => e.key,
    getTitle: (e) => {
      if (e.kind === "session") {
        return activeSessions.find((s) => s.id === e.sessionId)?.name ?? "";
      }
      if (e.kind === "diff" || e.kind === "file") {
        return e.path.split("/").pop() || e.path;
      }
      return "";
    },
    onReorder: (next) => {
      const split = splitUnifiedTabOrder(
        next.map((e) =>
          e.kind === "session"
            ? { kind: "session" as const, sessionId: e.sessionId }
            : e.kind === "diff"
              ? { kind: "diff" as const, path: e.path, layer: e.layer }
              : { kind: "file" as const, path: e.path },
        ),
        activeSessions,
        diffTabs,
        fileTabs,
      );
      // Apply ordering to local state immediately so the strip animates to
      // its new layout without waiting on the round-trip.
      // Sessions: merge the reordered active set back with archived sessions
      // (which never appear in navEntries) so the slice still has the full
      // list per-workspace.
      const archivedSessions = sessions.filter((s) => s.status === "Archived");
      setSessionsForWorkspace(workspaceId, [
        ...split.sessions,
        ...archivedSessions,
      ]);
      setFileTabsForWorkspace(workspaceId, split.files);
      setDiffTabsForWorkspace(workspaceId, split.diffs);
      if (split.sessionPersistIds.length > 0) {
        void reorderChatSessions(workspaceId, split.sessionPersistIds).catch(
          (err) =>
            console.error("[SessionTabs] Failed to persist session order:", err),
        );
      }
    },
  });

  // Right-click menu state. Tracks which tab was clicked (by its NavEntry key)
  // and the click position. Rendered once at the bottom; portal'd to body so
  // tab-strip overflow doesn't clip it.
  const [contextMenu, setContextMenu] = useState<
    { entryKey: string; x: number; y: number } | null
  >(null);

  // Close handler for file tabs — checks the dirty flag and routes to the
  // confirm-discard modal when there are unsaved edits. Reads dirty from
  // a fresh store snapshot so we always get the latest buffer state, not
  // a stale closure value.
  const requestCloseFileTab = useCallback(
    (path: string) => {
      const dirty = isFileTabDirty(useAppStore.getState(), workspaceId, path);
      if (dirty) {
        setPendingClosePaths([path]);
      } else {
        closeFileTab(workspaceId, path);
      }
    },
    [workspaceId, closeFileTab],
  );

  // Bulk variant: separate clean from dirty file paths, close clean ones
  // immediately, and queue the dirty ones into a single confirmation
  // prompt. Returns true if the caller can keep going with the rest of the
  // batch (no dirty files), false if the prompt is now blocking and the
  // caller should stop scheduling further closes for this iteration.
  const requestCloseFileTabsBatch = useCallback(
    (paths: string[]): boolean => {
      if (paths.length === 0) return true;
      const state = useAppStore.getState();
      const dirty: string[] = [];
      const clean: string[] = [];
      for (const p of paths) {
        if (isFileTabDirty(state, workspaceId, p)) dirty.push(p);
        else clean.push(p);
      }
      for (const p of clean) closeFileTab(workspaceId, p);
      if (dirty.length > 0) {
        setPendingClosePaths(dirty);
        return false;
      }
      return true;
    },
    [workspaceId, closeFileTab],
  );

  // Close a list of tabs (sessions, diffs, and/or files) sequentially. Sessions
  // get archived through the same backend command as the close button; diffs
  // and files drop from the local store (file tabs route through the
  // dirty-confirm modal). If any sessions are still running we confirm once
  // for the whole batch instead of once per tab.
  const closeEntries = useCallback(
    async (entries: NavEntry[]) => {
      if (entries.length === 0) return;
      const sessionEntries = entries.flatMap((e) =>
        e.kind === "session" ? [e] : [],
      );
      const runningSessions = sessionEntries
        .map((e) => activeSessions.find((s) => s.id === e.sessionId))
        .filter((s): s is ChatSession => !!s && s.agent_status === "Running");
      if (runningSessions.length > 0) {
        const message =
          runningSessions.length === 1
            ? t("session_running_confirm_close", { name: runningSessions[0].name })
            : t("session_running_confirm_close_multi", { count: runningSessions.length });
        if (!window.confirm(message)) return;
      }
      // File tabs: collect first, close clean ones immediately, route
      // dirty ones through a single batched confirm. Sessions and diffs
      // close inline as before.
      const filePaths: string[] = [];
      for (const entry of entries) {
        if (entry.kind === "session") {
          const session = activeSessions.find((s) => s.id === entry.sessionId);
          if (session) await archiveSessionImmediate(session);
        } else if (entry.kind === "diff") {
          closeDiffTab(workspaceId, entry.path, entry.layer);
        } else {
          filePaths.push(entry.path);
        }
      }
      requestCloseFileTabsBatch(filePaths);
    },
    [activeSessions, archiveSessionImmediate, closeDiffTab, requestCloseFileTabsBatch, t, workspaceId],
  );

  const navigateTabs = useCallback(
    (fromKey: string, direction: NavDirection) => {
      if (navEntries.length === 0) return;
      const idx = navEntries.findIndex((e) => e.key === fromKey);
      if (idx < 0) return;
      let targetIdx: number;
      switch (direction) {
        case "prev":
          targetIdx = (idx - 1 + navEntries.length) % navEntries.length;
          break;
        case "next":
          targetIdx = (idx + 1) % navEntries.length;
          break;
        case "first":
          targetIdx = 0;
          break;
        case "last":
          targetIdx = navEntries.length - 1;
          break;
      }
      const target = navEntries[targetIdx];
      if (target.kind === "session") {
        switchToSession(target.sessionId);
      } else if (target.kind === "diff") {
        switchToDiff(target.path, target.layer);
      } else {
        selectFileTab(workspaceId, target.path);
      }
      tabRefs.current.get(target.key)?.focus();
    },
    [navEntries, switchToSession, switchToDiff, selectFileTab, workspaceId],
  );

  const openContextMenu = useCallback(
    (entryKey: string, x: number, y: number) => {
      setContextMenu({ entryKey, x, y });
    },
    [],
  );

  // Helper to activate a nav entry (session, diff, or file tab).
  const selectEntry = useCallback(
    (entry: NavEntry) => {
      if (entry.kind === "session") {
        switchToSession(entry.sessionId);
      } else if (entry.kind === "diff") {
        switchToDiff(entry.path, entry.layer);
      } else {
        selectFileTab(workspaceId, entry.path);
      }
    },
    [switchToSession, switchToDiff, selectFileTab, workspaceId],
  );

  // Build the menu items lazily from the entry that was right-clicked. The
  // unified navEntries order is what "to the right" / "others" resolve against,
  // matching the order the user sees in the strip.
  const contextMenuItems = useMemo<AttachmentContextMenuItem[]>(() => {
    if (!contextMenu) return [];
    const idx = navEntries.findIndex((e) => e.key === contextMenu.entryKey);
    if (idx < 0) return [];
    const target = navEntries[idx];
    const others = navEntries.filter((_, i) => i !== idx);
    const toRight = navEntries.slice(idx + 1);
    return [
      { label: t("tab_close"), onSelect: () => void closeEntries([target]) },
      {
        label: t("tab_close_others"),
        onSelect: async () => {
          await closeEntries(others);
          selectEntry(target);
        },
        disabled: others.length === 0,
      },
      {
        label: t("tab_close_to_right"),
        onSelect: async () => {
          await closeEntries(toRight);
          selectEntry(target);
        },
        disabled: toRight.length === 0,
      },
      { label: t("tab_close_all"), onSelect: () => void closeEntries(navEntries) },
    ];
  }, [contextMenu, navEntries, closeEntries, selectEntry, t]);

  // Convenience helper that builds the drag-reorder slice of props each
  // sub-tab needs. Avoids repeating `tabReorder.getTabHandlers(...)` and the
  // drop-indicator booleans three times in the render block below.
  const dragPropsFor = (navKey: string) => {
    const entry = navEntryByKey.get(navKey);
    if (!entry) return null;
    const handlers = tabReorder.getTabHandlers(entry);
    return {
      navKey,
      handlers,
      isDragging: tabReorder.draggingId === navKey,
      dropBefore:
        tabReorder.dropTarget?.id === navKey &&
        tabReorder.dropTarget?.placement === "before",
      dropAfter:
        tabReorder.dropTarget?.id === navKey &&
        tabReorder.dropTarget?.placement === "after",
      isClickSuppressed: tabReorder.justEnded,
    };
  };

  return (
    <div
      className={styles.tabBar}
      role="tablist"
      data-tab-dragging={tabReorder.draggingId !== null || undefined}
    >
      {activeSessions.map((session) => {
        const navKey = sessionNavKey(session.id);
        const drag = dragPropsFor(navKey);
        return (
          <SessionTab
            key={session.id}
            session={session}
            isActive={
              session.id === selectedSessionId &&
              diffSelectedFile === null &&
              activeFileTab === null
            }
            onSelect={() => switchToSession(session.id)}
            onClose={() => handleArchive(session)}
            onRename={(name) => {
              updateChatSession(session.id, { name, name_edited: true });
            }}
            onNavigate={(direction) => navigateTabs(navKey, direction)}
            onContextMenu={(x, y) => openContextMenu(navKey, x, y)}
            tabRef={(el) => {
              if (el) tabRefs.current.set(navKey, el);
              else tabRefs.current.delete(navKey);
            }}
            drag={drag}
          />
        );
      })}
      {diffTabs.map((tab) => {
        const navKey = diffNavKey(tab.path, tab.layer);
        // A file tab takes visual priority — if a file is open, the diff
        // tab is no longer the "active" pane even if its path/layer still
        // matches the diff selection.
        const isActive =
          activeFileTab === null &&
          diffSelectedFile === tab.path &&
          diffSelectedLayer === tab.layer;
        const drag = dragPropsFor(navKey);
        return (
          <DiffTab
            key={navKey}
            tab={tab}
            isActive={isActive}
            onSelect={() => switchToDiff(tab.path, tab.layer)}
            onClose={() => closeDiffTab(workspaceId, tab.path, tab.layer)}
            onNavigate={(direction) => navigateTabs(navKey, direction)}
            onContextMenu={(x, y) => openContextMenu(navKey, x, y)}
            tabRef={(el) => {
              if (el) tabRefs.current.set(navKey, el);
              else tabRefs.current.delete(navKey);
            }}
            drag={drag}
          />
        );
      })}
      {fileTabs.map((path) => {
        const navKey = fileNavKey(path);
        const isActive = activeFileTab === path;
        const drag = dragPropsFor(navKey);
        return (
          <FileTab
            key={navKey}
            workspaceId={workspaceId}
            path={path}
            isActive={isActive}
            onSelect={() => selectFileTab(workspaceId, path)}
            onClose={() => requestCloseFileTab(path)}
            onNavigate={(direction) => navigateTabs(navKey, direction)}
            onContextMenu={(x, y) => openContextMenu(navKey, x, y)}
            tabRef={(el) => {
              if (el) tabRefs.current.set(navKey, el);
              else tabRefs.current.delete(navKey);
            }}
            drag={drag}
          />
        );
      })}
      <button
        type="button"
        className={styles.addBtn}
        onClick={handleCreate}
        title={t("session_new")}
        aria-label={t("session_new")}
        aria-busy={creating}
        disabled={creating}
      >
        <Plus size={14} />
      </button>
      {contextMenu && contextMenuItems.length > 0 && (
        <AttachmentContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
      {pendingClosePaths.length > 0 && (
        <DiscardUnsavedChangesConfirm
          count={pendingClosePaths.length}
          onConfirm={() => {
            for (const p of pendingClosePaths) {
              closeFileTab(workspaceId, p);
            }
            setPendingClosePaths([]);
          }}
          onClose={() => setPendingClosePaths([])}
        />
      )}
      {tabReorder.dragGhost && tabReorder.draggingId !== null && (
        <TabDragGhost ghost={tabReorder.dragGhost} />
      )}
    </div>
  );
}

// Drag-reorder slice of props each sub-tab consumes. Built once per render
// by SessionTabs.dragPropsFor; passed straight through to the tab element.
interface TabDragProps {
  navKey: string;
  handlers: {
    onPointerDown: (ev: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (ev: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (ev: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (ev: ReactPointerEvent<HTMLElement>) => void;
  };
  isDragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  /** Reads the latest "did a drag just end" flag from the hook. Tab onClick
   *  handlers call this to skip the synthetic post-pointerup click. */
  isClickSuppressed: () => boolean;
}

interface TabProps {
  session: ChatSession;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
  onNavigate: (direction: "prev" | "next" | "first" | "last") => void;
  onContextMenu: (x: number, y: number) => void;
  tabRef: (el: HTMLDivElement | null) => void;
  drag: TabDragProps | null;
}

function SessionTab({
  session,
  isActive,
  onSelect,
  onClose,
  onRename,
  onNavigate,
  onContextMenu,
  tabRef,
  drag,
}: TabProps) {
  const { t } = useTranslation("chat");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    setDraft(session.name);
    setEditing(true);
  };

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === session.name) {
      setEditing(false);
      setDraft(session.name);
      return;
    }
    try {
      await renameChatSession(session.id, next);
      onRename(next);
    } catch (err) {
      console.error("[SessionTabs] Failed to rename session:", err);
    }
    setEditing(false);
  };

  const cancel = () => {
    setDraft(session.name);
    setEditing(false);
  };

  return (
    <div
      ref={tabRef}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      data-session-tab-key={drag?.navKey}
      className={`${styles.tab} ${isActive ? styles.active : ""} ${drag?.isDragging ? styles.dragging : ""}`}
      onClick={() => {
        if (drag?.isClickSuppressed()) return;
        if (!editing) onSelect();
      }}
      onContextMenu={(e) => {
        // Skip while inline-renaming so the input's native context menu
        // (cut/copy/paste) still works.
        if (editing) return;
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        startEditing();
      }}
      onPointerDown={drag?.handlers.onPointerDown}
      onPointerMove={drag?.handlers.onPointerMove}
      onPointerUp={drag?.handlers.onPointerUp}
      onPointerCancel={drag?.handlers.onPointerCancel}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        } else if (e.key === "F2") {
          e.preventDefault();
          startEditing();
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          onNavigate("prev");
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onNavigate("next");
        } else if (e.key === "Home") {
          e.preventDefault();
          onNavigate("first");
        } else if (e.key === "End") {
          e.preventDefault();
          onNavigate("last");
        }
      }}
    >
      {drag?.dropBefore && (
        <span className={`${styles.dropEdge} ${styles.dropBefore}`} aria-hidden />
      )}
      {drag?.dropAfter && (
        <span className={`${styles.dropEdge} ${styles.dropAfter}`} aria-hidden />
      )}
      <span className={`${styles.icon} ${session.needs_attention ? styles.pulse : ""}`}>
        <SessionStatusIcon status={statusFor(session)} size={12} />
      </span>
      {editing ? (
        <input
          ref={inputRef}
          className={styles.nameInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
          maxLength={60}
        />
      ) : (
        <span className={styles.name} title={session.name}>
          {session.name}
        </span>
      )}
      <button
        type="button"
        className={styles.closeBtn}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title={t("session_close")}
        aria-label={t("session_close")}
      >
        <X size={12} />
      </button>
    </div>
  );
}

interface FileTabProps {
  workspaceId: string;
  path: string;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onNavigate: (direction: NavDirection) => void;
  onContextMenu: (x: number, y: number) => void;
  tabRef: (el: HTMLDivElement | null) => void;
  drag: TabDragProps | null;
}

function FileTab({
  workspaceId,
  path,
  isActive,
  onSelect,
  onClose,
  onNavigate,
  onContextMenu,
  tabRef,
  drag,
}: FileTabProps) {
  const { t } = useTranslation("chat");
  // Subscribe only to dirty state for this tab's buffer. Reading the whole
  // buffer would re-render the tab on every keystroke; reading just dirty
  // means we re-render only when it crosses the saved/unsaved boundary.
  const dirty = useAppStore(
    (s) =>
      !!s.fileBuffers[fileBufferKey(workspaceId, path)] &&
      s.fileBuffers[fileBufferKey(workspaceId, path)].buffer !==
        s.fileBuffers[fileBufferKey(workspaceId, path)].baseline,
  );
  const basename = path.split("/").pop() || path;
  const Icon = getFileIcon(basename);
  return (
    <div
      ref={tabRef}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      data-session-tab-key={drag?.navKey}
      className={`${styles.tab} ${isActive ? styles.active : ""} ${drag?.isDragging ? styles.dragging : ""}`}
      onClick={() => {
        if (drag?.isClickSuppressed()) return;
        onSelect();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      onPointerDown={drag?.handlers.onPointerDown}
      onPointerMove={drag?.handlers.onPointerMove}
      onPointerUp={drag?.handlers.onPointerUp}
      onPointerCancel={drag?.handlers.onPointerCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          onNavigate("prev");
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onNavigate("next");
        } else if (e.key === "Home") {
          e.preventDefault();
          onNavigate("first");
        } else if (e.key === "End") {
          e.preventDefault();
          onNavigate("last");
        }
      }}
    >
      {drag?.dropBefore && (
        <span className={`${styles.dropEdge} ${styles.dropBefore}`} aria-hidden />
      )}
      {drag?.dropAfter && (
        <span className={`${styles.dropEdge} ${styles.dropAfter}`} aria-hidden />
      )}
      <span className={styles.icon}>
        <Icon size={12} />
      </span>
      <span className={styles.name} title={path}>
        {basename}
        {dirty && (
          <span className={styles.dirtyDot} aria-label={t("file_dirty_aria")} />
        )}
      </span>
      <button
        type="button"
        className={styles.closeBtn}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title={t("session_close_file")}
        aria-label={t("session_close_file")}
      >
        <X size={12} />
      </button>
    </div>
  );
}

interface DiffTabProps {
  tab: DiffFileTab;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onNavigate: (direction: NavDirection) => void;
  onContextMenu: (x: number, y: number) => void;
  tabRef: (el: HTMLDivElement | null) => void;
  drag: TabDragProps | null;
}

function DiffTab({
  tab,
  isActive,
  onSelect,
  onClose,
  onNavigate,
  onContextMenu,
  tabRef,
  drag,
}: DiffTabProps) {
  const { t } = useTranslation("chat");
  // Show just the basename in the tab; the full path goes in the tooltip
  // (mirrors how editors label file tabs). `path.split("/").pop()` is fine
  // because diff paths come from git and use forward slashes on every
  // platform.
  const basename = tab.path.split("/").pop() || tab.path;
  return (
    <div
      ref={tabRef}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      data-session-tab-key={drag?.navKey}
      className={`${styles.tab} ${isActive ? styles.active : ""} ${drag?.isDragging ? styles.dragging : ""}`}
      onClick={() => {
        if (drag?.isClickSuppressed()) return;
        onSelect();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      onPointerDown={drag?.handlers.onPointerDown}
      onPointerMove={drag?.handlers.onPointerMove}
      onPointerUp={drag?.handlers.onPointerUp}
      onPointerCancel={drag?.handlers.onPointerCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          onNavigate("prev");
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onNavigate("next");
        } else if (e.key === "Home") {
          e.preventDefault();
          onNavigate("first");
        } else if (e.key === "End") {
          e.preventDefault();
          onNavigate("last");
        }
      }}
    >
      {drag?.dropBefore && (
        <span className={`${styles.dropEdge} ${styles.dropBefore}`} aria-hidden />
      )}
      {drag?.dropAfter && (
        <span className={`${styles.dropEdge} ${styles.dropAfter}`} aria-hidden />
      )}
      <span className={styles.icon}>
        <FileDiffIcon size={12} />
      </span>
      <span className={styles.name} title={tab.path}>
        {basename}
      </span>
      <button
        type="button"
        className={styles.closeBtn}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title={t("session_close_diff")}
        aria-label={t("session_close_diff")}
      >
        <X size={12} />
      </button>
    </div>
  );
}
