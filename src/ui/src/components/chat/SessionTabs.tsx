import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDiff as FileDiffIcon, Plus } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import {
  fileBufferKey,
  isFileTabDirty,
} from "../../stores/slices/fileTreeSlice";
import {
  renameChatSession,
  readWorkspaceFileForViewer,
  reorderChatSessions,
} from "../../services/tauri";
import { useTabDragReorder } from "../../hooks/useTabDragReorder";
import { TabDragGhost } from "../shared/TabDragGhost";
import {
  buildWorkspaceTabNavEntries,
  type NavEntry,
  splitUnifiedTabOrder,
} from "./sessionTabsLogic";
import { tooltipAttributes } from "../../hotkeys/display";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import { SessionStatusIcon, type SessionStatusKind } from "../shared/SessionStatusIcon";
import { DangerousFlagBadge } from "./DangerousFlagBadge";
import { hasDangerousFlag } from "../../stores/slices/workspaceClaudeFlagsSlice";
import { AttachmentContextMenu } from "./AttachmentContextMenu";
import { DiscardUnsavedChangesConfirm } from "../files/DiscardUnsavedChangesConfirm";
import { FilePathContextMenu } from "../files/FilePathContextMenu";
import { useFilePathActions } from "../files/useFilePathActions";
import { InlineRenameInput } from "../files/InlineRenameInput";
import { getFileIcon } from "../../utils/fileIcons";
import {
  statusColor,
  statusForOpenFileTab,
  statusLayerForOpenFileTab,
  statusLabel,
} from "../files/fileTreeStatus";
import type {
  ChatSession,
  DiffFileTab,
  DiffLayer,
  FileStatus,
  GitFileLayer,
} from "../../types";
import { TabShell, type NavDirection, type TabDragProps, type TabShellBaseProps } from "./TabShell";
import { useSessionTabActions } from "./useSessionTabActions";
import { useTabContextMenu } from "./useTabContextMenu";
import styles from "./SessionTabs.module.css";

// `NavEntry` and `buildWorkspaceTabNavEntries` are imported from
// `./sessionTabsLogic` so the cycle-tabs hotkey and this component
// agree on the unified order without each rebuilding it from scratch.
// The per-kind key factories (`sessionNavKey` / `diffNavKey` /
// `fileNavKey`) live in the same module and are only consumed there —
// SessionTabs reads `entry.key` off the built nav entries.

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
  const diffStagedFiles = useAppStore((s) => s.diffStagedFiles);
  const fileTabs = useAppStore(
    (s) => s.fileTabsByWorkspace[workspaceId] ?? EMPTY_FILE_TABS,
  );
  const activeFileTab = useAppStore(
    (s) => s.activeFileTabByWorkspace[workspaceId] ?? null,
  );
  const setSessionsForWorkspace = useAppStore((s) => s.setSessionsForWorkspace);
  const updateChatSession = useAppStore((s) => s.updateChatSession);
  const selectSession = useAppStore((s) => s.selectSession);
  const selectDiffTab = useAppStore((s) => s.selectDiffTab);
  const closeDiffTab = useAppStore((s) => s.closeDiffTab);
  const selectFileTab = useAppStore((s) => s.selectFileTab);
  const closeFileTab = useAppStore((s) => s.closeFileTab);
  const clearActiveFileTab = useAppStore((s) => s.clearActiveFileTab);
  const keybindings = useAppStore((s) => s.keybindings);
  const isMac = isMacHotkeyPlatform();

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
  const [renamingFilePath, setRenamingFilePath] = useState<string | null>(null);
  const filePathActions = useFilePathActions(workspaceId);

  // Memoized so navEntries / navigateTabs stay referentially stable when the
  // session list hasn't changed — without this, `sessions.filter` returns a
  // fresh array each render and defeats the downstream useMemo/useCallback.
  const activeSessions = useMemo(
    () => sessions.filter((s) => s.status === "Active"),
    [sessions],
  );
  // O(1) id → session lookup for the render loop, drag ghost title, and
  // bulk close (avoids an `activeSessions.find` per tab).
  const activeSessionById = useMemo(() => {
    const m = new Map<string, ChatSession>();
    for (const s of activeSessions) m.set(s.id, s);
    return m;
  }, [activeSessions]);

  // Refs keyed by a unified nav key (sessionNavKey / diffNavKey) so arrow-key
  // navigation can focus any tab in the strip, regardless of kind.
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const tabOrderForWorkspace = useAppStore(
    (s) => s.tabOrderByWorkspace[workspaceId],
  );
  const setTabOrderForWorkspace = useAppStore((s) => s.setTabOrderForWorkspace);
  // Per-kind setters used by `onReorder` to keep the per-kind arrays in
  // sync with the unified order — other call sites (closeFileTab etc.)
  // still consult the per-kind arrays for adjacency, so they have to
  // match the visible order.
  const setFileTabsForWorkspace = useAppStore((s) => s.setFileTabsForWorkspace);
  const setDiffTabsForWorkspace = useAppStore((s) => s.setDiffTabsForWorkspace);

  // Unified ordered list of focusable tab entries. Default layout is
  // sessions → diffs → files; once the user has dragged the strip into
  // a custom unified order (`tabOrderByWorkspace`), the helper honors that
  // and reconciles against the live per-kind state (drops entries whose
  // underlying tab is gone; appends newly-opened tabs at the end so they
  // don't disappear into the abyss).
  const navEntries = useMemo<NavEntry[]>(
    () =>
      buildWorkspaceTabNavEntries({
        activeSessions,
        diffTabs,
        fileTabs,
        tabOrder: tabOrderForWorkspace,
      }),
    [activeSessions, diffTabs, fileTabs, tabOrderForWorkspace],
  );

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
        return activeSessionById.get(e.sessionId)?.name ?? "";
      }
      if (e.kind === "diff" || e.kind === "file") {
        return e.path.split("/").pop() || e.path;
      }
      return "";
    },
    onReorder: (next) => {
      // Convert the reordered nav-entry list into the unified-tab-order
      // shape. The render block iterates the unified order directly, but
      // we ALSO write the per-kind arrays back so other code paths that
      // read them — e.g. `closeFileTab` picking the adjacent tab to
      // activate, or `closeDiffTab`/keyboard nav after-close — see the
      // same relative order the user just dragged into. Without those
      // writebacks, those code paths still pick from the pre-drag
      // sequence (Copilot review of the second push). Sessions are
      // additionally persisted via reorder_chat_sessions for restart
      // round-tripping.
      const unified = next.map((e) =>
        e.kind === "session"
          ? { kind: "session" as const, sessionId: e.sessionId }
          : e.kind === "diff"
            ? { kind: "diff" as const, path: e.path, layer: e.layer }
            : { kind: "file" as const, path: e.path },
      );
      setTabOrderForWorkspace(workspaceId, unified);
      const split = splitUnifiedTabOrder(
        unified,
        activeSessions,
        diffTabs,
        fileTabs,
      );
      // Sessions: merge the reordered active set back with archived
      // sessions (which never appear in navEntries) so the slice still
      // has the full list per-workspace.
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
    [workspaceId, closeFileTab, setPendingClosePaths],
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
    [workspaceId, closeFileTab, setPendingClosePaths],
  );

  const { creating, handleCreate, handleArchive, closeEntries } =
    useSessionTabActions({
      workspaceId,
      activeSessions,
      activeSessionById,
      diffTabs,
      fileTabs,
      selectedSessionId,
      switchToSession,
      requestCloseFileTabsBatch,
    });

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

  const {
    contextMenu,
    contextMenuItems,
    contextMenuEntry,
    openContextMenu,
    closeContextMenu,
  } = useTabContextMenu({
    navEntries,
    navEntryByKey,
    diffStagedFiles,
    closeEntries,
    selectEntry,
  });

  // Convenience helper that builds the drag-reorder slice of props each
  // sub-tab needs. Avoids repeating `tabReorder.getTabHandlers(...)` and the
  // drop-indicator booleans three times in the render block below.
  const dragPropsFor = (navKey: string): TabDragProps | null => {
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
      {/* Single render loop over the unified navEntries — this is what
          honors a user-customized order. The earlier "sessions.map then
          diffs.map then files.map" approach re-segregated tabs back into
          their kinds after every drop, defeating cross-kind drag. */}
      {navEntries.map((entry) => {
        const navKey = entry.key;
        const drag = dragPropsFor(navKey);
        if (entry.kind === "session") {
          const session = activeSessionById.get(entry.sessionId);
          if (!session) return null;
          return (
            <SessionTab
              key={navKey}
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
        }
        if (entry.kind === "diff") {
          const tab = diffTabs.find(
            (d) => d.path === entry.path && d.layer === entry.layer,
          );
          if (!tab) return null;
          // A file tab takes visual priority — if a file is open, the diff
          // tab is no longer the "active" pane even if its path/layer still
          // matches the diff selection.
          const isActive =
            activeFileTab === null &&
            diffSelectedFile === tab.path &&
            diffSelectedLayer === tab.layer;
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
        }
        // entry.kind === "file"
        const isActive = activeFileTab === entry.path;
        const gitStatus = statusForOpenFileTab(entry.path, diffStagedFiles);
        const gitLayer = statusLayerForOpenFileTab(entry.path, diffStagedFiles);
        return (
          <FileTab
            key={navKey}
            workspaceId={workspaceId}
            path={entry.path}
            gitStatus={gitStatus}
            gitLayer={gitLayer}
            isActive={isActive}
            onSelect={() => selectFileTab(workspaceId, entry.path)}
            onClose={() => requestCloseFileTab(entry.path)}
            onNavigate={(direction) => navigateTabs(navKey, direction)}
            onContextMenu={(x, y) => openContextMenu(navKey, x, y)}
            renaming={renamingFilePath === entry.path}
            onRenameCommit={async (newName) => {
              try {
                await filePathActions.renamePath(
                  { path: entry.path, isDirectory: false, exists: true },
                  newName,
                );
                setRenamingFilePath(null);
                return true;
              } catch (err) {
                console.error("[SessionTabs] Failed to rename file:", err);
                useAppStore.getState().addToast(
                  t("tab_rename_failed", {
                    error: String(err),
                    defaultValue: `Rename failed: ${String(err)}`,
                  }),
                );
                return false;
              }
            }}
            onRenameCancel={() => setRenamingFilePath(null)}
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
        {...tooltipAttributes(t("session_new"), "global.new-tab", keybindings, isMac, "bottom")}
        aria-label={t("session_new")}
        aria-busy={creating}
        disabled={creating}
      >
        <Plus size={14} />
      </button>
      {contextMenu && contextMenuItems && contextMenuEntry?.kind === "file" && (
        <FilePathContextMenu
          workspaceId={workspaceId}
          target={{
            path: contextMenuEntry.path,
            isDirectory: false,
            exists: statusForOpenFileTab(contextMenuEntry.path, diffStagedFiles) !== "Deleted",
          }}
          x={contextMenu.x}
          y={contextMenu.y}
          beforeItems={contextMenuItems}
          onRenameRequest={(target) => setRenamingFilePath(target.path)}
          onClose={closeContextMenu}
        />
      )}
      {contextMenu && contextMenuItems && contextMenuEntry?.kind !== "file" && (
        <AttachmentContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
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

interface TabProps extends TabShellBaseProps {
  session: ChatSession;
  onRename: (name: string) => void;
}

function SessionTab({ session, onRename, ...shell }: TabProps) {
  const { t } = useTranslation("chat");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const repoId = useAppStore(
    (s) =>
      s.workspaces.find((w) => w.id === session.workspace_id)?.repository_id ??
      null,
  );
  const flagsEntry = useAppStore(
    (s) => s.claudeFlagsByWorkspace[session.workspace_id],
  );
  const resolved = flagsEntry?.resolved ?? [];
  const loadWorkspaceClaudeFlags = useAppStore(
    (s) => s.loadWorkspaceClaudeFlags,
  );

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!flagsEntry && repoId) {
      void loadWorkspaceClaudeFlags(session.workspace_id, repoId);
    }
  }, [flagsEntry, repoId, session.workspace_id, loadWorkspaceClaudeFlags]);

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
    <TabShell
      {...shell}
      closeLabel={t("session_close")}
      locked={editing}
      onRenameKey={startEditing}
      onDoubleClick={(e) => {
        e.stopPropagation();
        startEditing();
      }}
    >
      <span className={`${styles.icon} ${session.needs_attention ? styles.pulse : ""}`}>
        <SessionStatusIcon status={statusFor(session)} size={12} />
      </span>
      <DangerousFlagBadge active={hasDangerousFlag(resolved)} />

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
    </TabShell>
  );
}

interface FileTabProps extends TabShellBaseProps {
  workspaceId: string;
  path: string;
  gitStatus: FileStatus | null;
  gitLayer: GitFileLayer | null;
  renaming: boolean;
  onRenameCommit: (newName: string) => Promise<boolean>;
  onRenameCancel: () => void;
}

function FileTab({
  workspaceId,
  path,
  gitStatus,
  gitLayer,
  renaming,
  onRenameCommit,
  onRenameCancel,
  ...shell
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
  // Mirror selector for the "external change pending" flag. Set by
  // `applyExternalFileChange` when an on-disk write lands while the
  // buffer was dirty (so the watcher couldn't auto-update without
  // clobbering edits). Clicking the badge opens disk content via
  // `reloadFileBufferFromDisk`, dropping the in-flight edit.
  const externallyChanged = useAppStore(
    (s) =>
      s.fileBuffers[fileBufferKey(workspaceId, path)]?.externallyChanged ===
      true,
  );
  const reloadFileBufferFromDisk = useAppStore(
    (s) => s.reloadFileBufferFromDisk,
  );
  const basename = path.split("/").pop() || path;
  const Icon = getFileIcon(basename);
  const statusTitle =
    gitStatus == null
      ? null
      : typeof gitStatus === "string"
        ? gitStatus
        : `Renamed from ${gitStatus.Renamed.from}`;

  return (
    <TabShell
      {...shell}
      closeLabel={t("session_close_file")}
      locked={renaming}
      detachDragWhileLocked
    >
      <span className={styles.icon}>
        {/* eslint-disable-next-line react-hooks/static-components -- fileIcons returns stable module-level lucide components. */}
        <Icon size={12} />
      </span>
      {renaming ? (
        <InlineRenameInput
          name={basename}
          className={styles.nameInput}
          ariaLabel={`Rename ${basename}`}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
        />
      ) : (
        <span className={styles.name} title={path}>
          {basename}
          {dirty && (
            <span className={styles.dirtyDot} aria-label={t("file_dirty_aria")} />
          )}
          {externallyChanged && (
            // Click-to-reload affordance — re-reads disk and applies via
            // `reloadFileBufferFromDisk`, which drops the in-flight
            // dirty buffer in exchange for the new disk content. Pointer
            // and keyboard events both stop propagation so the parent
            // tab doesn't steal them: `onClick` covers mouse + native
            // button-activation, `onKeyDown` blocks Enter / Space from
            // bubbling up to the parent's keyboard handler (which
            // calls `preventDefault()` on those keys, which would
            // otherwise suppress the button's own activation).
            <button
              type="button"
              className={styles.externalDot}
              title={t("file_external_change_reload_tooltip")}
              aria-label={t("file_external_change_reload_aria")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                }
              }}
              onClick={(e) => {
                e.stopPropagation();
                void readWorkspaceFileForViewer(workspaceId, path)
                  .then((res) => {
                    reloadFileBufferFromDisk(
                      workspaceId,
                      path,
                      res.content ?? "",
                      res.size_bytes,
                      res.truncated,
                    );
                  })
                  .catch((err) => {
                    console.error(
                      "[file-tab] reload-from-disk failed",
                      err,
                    );
                  });
              }}
            />
          )}
        </span>
      )}
      {gitStatus && (
        <span
          className={styles.fileStatus}
          style={{ color: statusColor(gitStatus) }}
          title={statusTitle ?? undefined}
          aria-label={statusTitle ?? undefined}
        >
          {statusLabel(gitStatus, gitLayer)}
        </span>
      )}
    </TabShell>
  );
}

interface DiffTabProps extends TabShellBaseProps {
  tab: DiffFileTab;
}

function DiffTab({ tab, ...shell }: DiffTabProps) {
  const { t } = useTranslation("chat");
  // Show just the basename in the tab; the full path goes in the tooltip
  // (mirrors how editors label file tabs). `path.split("/").pop()` is fine
  // because diff paths come from git and use forward slashes on every
  // platform.
  const basename = tab.path.split("/").pop() || tab.path;
  return (
    <TabShell {...shell} closeLabel={t("session_close_diff")}>
      <span className={styles.icon}>
        <FileDiffIcon size={12} />
      </span>
      <span className={styles.name} title={tab.path}>
        {basename}
      </span>
    </TabShell>
  );
}
