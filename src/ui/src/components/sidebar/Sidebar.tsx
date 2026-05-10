import { memo, useRef, useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore } from "../../stores/useAppStore";
import { isAgentBusy } from "../../utils/agentStatus";
import {
  archiveWorkspace,
  deleteAppSetting,
  reorderRepositories,
  reorderWorkspaces,
  renameWorkspace,
  restoreWorkspace,
  generateWorkspaceName,
  createWorkspace,
  getRepoConfig,
  runWorkspaceSetup,
  connectRemote,
  disconnectRemote,
  removeRemoteConnection,
  sendRemoteCommand,
  pairWithServer,
  openInEditor,
  openWorkspaceInTerminal,
  listChatSessions,
  interruptPtyForeground,
} from "../../services/tauri";
import { Settings, Link, X, Share2, Plus, Globe, Archive, Trash2, Cog, Filter, LayoutDashboard, ChevronRight, ChevronDown, ArrowDownAZ } from "lucide-react";
import { RepoIcon } from "../shared/RepoIcon";
import { extractRemoteWorkspace } from "./remoteWorkspaceResponse";
import { HelpMenu } from "./HelpMenu";
import { UpdateBanner } from "../layout/UpdateBanner";
import { ContextMenu, type ContextMenuItem } from "../shared/ContextMenu";
import { WorkspaceStatusIcon } from "./WorkspaceStatusIcon";
import { useTabDragReorder } from "../../hooks/useTabDragReorder";
import { TabDragGhost } from "../shared/TabDragGhost";
import { getHotkeyLabel, tooltipAttributes, tooltipWithHotkey } from "../../hotkeys/display";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import type { HotkeyActionId } from "../../hotkeys/actions";
import {
  isManualWorkspaceOrder,
  orderRepoWorkspaces,
  workspaceOrderModeKey,
} from "../../utils/workspaceOrdering";
import {
  buildWorkspaceContextMenuItems,
  type WorkspaceContextMenuLabels,
} from "./workspaceContextMenu";
import type { ChatSession } from "../../types";
import styles from "./Sidebar.module.css";

type StatusBucketKey = "in-progress" | "in-review" | "draft" | "merged" | "closed" | "archived";
const STATUS_BUCKET_ORDER: StatusBucketKey[] = [
  "merged", "in-review", "draft", "in-progress", "closed", "archived",
];

function workspaceContextMenuLabels(t: TFunction<"sidebar">): WorkspaceContextMenuLabels {
  return {
    renameWorkspace: t("context_rename_workspace"),
    markAsUnread: t("context_mark_as_unread"),
    openInFileManager: t("context_open_in_file_manager"),
    openInTerminal: t("context_open_in_terminal"),
    copyWorkingDirectory: t("context_copy_working_directory"),
    copyClaudeSessionId: t("context_copy_claude_session_id"),
    archiveWorkspace: t("archive_workspace"),
    restoreWorkspace: t("restore_workspace"),
    deleteWorkspace: t("delete_workspace"),
  };
}

function pickClaudeSessionId(
  sessions: readonly ChatSession[],
  selectedSessionId: string | undefined,
): string | null {
  return (
    sessions.find(
      (session) =>
        session.id === selectedSessionId &&
        session.status === "Active" &&
        session.session_id,
    )?.session_id ??
    sessions.find(
      (session) => session.status === "Active" && session.session_id,
    )?.session_id ??
    null
  );
}

export const Sidebar = memo(function Sidebar() {
  const repositories = useAppStore((s) => s.repositories);
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const selectedRepositoryId = useAppStore((s) => s.selectedRepositoryId);
  const selectRepository = useAppStore((s) => s.selectRepository);
  const goToDashboard = useAppStore((s) => s.goToDashboard);
  const sidebarGroupBy = useAppStore((s) => s.sidebarGroupBy);
  const setSidebarGroupBy = useAppStore((s) => s.setSidebarGroupBy);
  const sidebarRepoFilter = useAppStore((s) => s.sidebarRepoFilter);
  const setSidebarRepoFilter = useAppStore((s) => s.setSidebarRepoFilter);
  const sidebarShowArchived = useAppStore((s) => s.sidebarShowArchived);
  const setSidebarShowArchived = useAppStore((s) => s.setSidebarShowArchived);
  const repoCollapsed = useAppStore((s) => s.repoCollapsed);
  const toggleRepoCollapsed = useAppStore((s) => s.toggleRepoCollapsed);
  const statusGroupCollapsed = useAppStore((s) => s.statusGroupCollapsed);
  const toggleStatusGroupCollapsed = useAppStore((s) => s.toggleStatusGroupCollapsed);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const openModal = useAppStore((s) => s.openModal);
  const openSettings = useAppStore((s) => s.openSettings);
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const markWorkspaceAsUnread = useAppStore((s) => s.markWorkspaceAsUnread);
  const addToast = useAppStore((s) => s.addToast);
  const unreadCompletions = useAppStore((s) => s.unreadCompletions);
  const sessionsByWorkspace = useAppStore((s) => s.sessionsByWorkspace);
  const setSessionsForWorkspace = useAppStore((s) => s.setSessionsForWorkspace);
  const scmSummary = useAppStore((s) => s.scmSummary);
  const setRepositories = useAppStore((s) => s.setRepositories);
  const setWorkspaces = useAppStore((s) => s.setWorkspaces);
  const manualWorkspaceOrderByRepo = useAppStore(
    (s) => s.manualWorkspaceOrderByRepo,
  );
  const markWorkspaceOrderManual = useAppStore(
    (s) => s.markWorkspaceOrderManual,
  );
  const clearManualWorkspaceOrder = useAppStore(
    (s) => s.clearManualWorkspaceOrder,
  );
  const metaKeyHeld = useAppStore((s) => s.metaKeyHeld);
  const keybindings = useAppStore((s) => s.keybindings);
  const isMac = isMacHotkeyPlatform();
  const { t } = useTranslation("sidebar");

  // Filter dropdown state
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterDropdownRef = useRef<HTMLDivElement>(null);

  // Close filter menu when clicking outside
  useEffect(() => {
    if (!filterMenuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node)) {
        setFilterMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [filterMenuOpen]);

  // Pointer-based reorder state (HTML5 drag-and-drop doesn't work in WKWebView)
  const [draggedRepoId, setDraggedRepoId] = useState<string | null>(null);
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null);
  const repoGroupRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragStartPos = useRef<{ x: number; y: number; id: string; pointerId: number } | null>(null);
  const didDragRef = useRef(false);
  const DRAG_THRESHOLD = 5; // px before drag activates
  const workspaceTerminalCommands = useAppStore((s) => s.workspaceTerminalCommands);
  const showSidebarRunningCommands = useAppStore((s) => s.showSidebarRunningCommands);
  // Per-workspace expansion state for the running-commands list. Collapsed
  // by default — the row shows a "N running" summary; clicking expands the
  // list. State lives in the component (not the store) since this is pure
  // ephemeral UI state that doesn't need to survive a reload.
  const [expandedCommandWorkspaces, setExpandedCommandWorkspaces] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleCommandsExpanded = useCallback((wsId: string) => {
    setExpandedCommandWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  }, []);

  const [renamingWsId, setRenamingWsId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCancelledRef = useRef(false);

  const creatingRef = useRef(false);
  const archivingRef = useRef<Set<string>>(new Set());
  const restoringRef = useRef<Set<string>>(new Set());
  // Store-backed optimistic-row state — replaces a local useState pair so
  // that any caller of useCreateWorkspace (welcome card, project-scoped
  // CTA, Cmd+Shift+N hotkey) lights up the same sidebar placeholder row
  // as the inline `+` button does. The setter is still used below for
  // the inline path, which doesn't yet route through the hook.
  const creatingWorkspaceRepoId = useAppStore((s) => s.creatingWorkspaceRepoId);
  const setCreatingWorkspaceRepoId = useAppStore(
    (s) => s.setCreatingWorkspaceRepoId,
  );
  const creatingWorkspace = creatingWorkspaceRepoId
    ? { repoId: creatingWorkspaceRepoId }
    : null;
  const setCreatingWorkspace = useCallback(
    (v: { repoId: string } | null) =>
      setCreatingWorkspaceRepoId(v?.repoId ?? null),
    [setCreatingWorkspaceRepoId],
  );
  const [repoContextMenu, setRepoContextMenu] = useState<{
    repoId: string;
    x: number;
    y: number;
  } | null>(null);
  const [workspaceContextMenu, setWorkspaceContextMenu] = useState<{
    workspaceId: string;
    x: number;
    y: number;
  } | null>(null);

  const repoContextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!repoContextMenu) return [];
    const repoId = repoContextMenu.repoId;
    return [
      {
        label: "Sort Workspaces Automatically",
        icon: <ArrowDownAZ size={14} />,
        disabled: !isManualWorkspaceOrder(manualWorkspaceOrderByRepo, repoId),
        onSelect: async () => {
          await deleteAppSetting(workspaceOrderModeKey(repoId));
          clearManualWorkspaceOrder(repoId);
        },
      },
    ];
  }, [clearManualWorkspaceOrder, manualWorkspaceOrderByRepo, repoContextMenu]);

  const handleCreateWorkspace = useCallback(async (repoId: string) => {
    if (creatingRef.current) return;
    creatingRef.current = true;

    // Show optimistic loading workspace
    setCreatingWorkspace({ repoId });

    try {
      const generated = await generateWorkspaceName();
      // Always skip setup initially — we'll prompt for confirmation if needed.
      const result = await createWorkspace(repoId, generated.slug, true);

      // Remove optimistic workspace
      setCreatingWorkspace(null);

      addWorkspace(result.workspace);
      // Mirror useCreateWorkspace's expand-on-create — the sidebar still
      // has its own orchestration, but a collapsed parent group hiding a
      // freshly created workspace is the same UX bug from either path.
      useAppStore.getState().expandRepo(repoId);
      selectWorkspace(result.workspace.id);
      const sessionId = result.default_session_id;
      if (generated.message) {
        addChatMessage(sessionId, {
          id: crypto.randomUUID(),
          workspace_id: result.workspace.id,
          chat_session_id: sessionId,
          role: "System",
          content: generated.message,
          cost_usd: null,
          duration_ms: null,
          created_at: new Date().toISOString(),
          thinking: null,
          input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null,
          author_participant_id: null, author_display_name: null,
        });
      }
      // Check if a setup script exists and prompt user to review it.
      try {
        const config = await getRepoConfig(repoId);
        const repo = useAppStore.getState().repositories.find((r) => r.id === repoId);
        const script = config.setup_script ?? repo?.setup_script;
        const source = config.setup_script ? "repo" : "settings";
        if (script) {
          if (repo?.setup_script_auto_run) {
            const wsId = result.workspace.id;
            runWorkspaceSetup(wsId).then((sr) => {
              if (sr) {
                const lbl = sr.source === "repo" ? ".claudette.json" : "settings";
                const status = sr.success ? "completed" : sr.timed_out ? "timed out" : "failed";
                addChatMessage(sessionId, {
                  id: crypto.randomUUID(),
                  workspace_id: wsId,
                  chat_session_id: sessionId,
                  role: "System",
                  content: `Setup script (${lbl}) ${status}${sr.output ? `:\n${sr.output}` : ""}`,
                  cost_usd: null, duration_ms: null,
                  created_at: new Date().toISOString(),
                  thinking: null,
                  input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null,
          author_participant_id: null, author_display_name: null,
                });
              }
            }).catch((err) => {
              addChatMessage(sessionId, {
                id: crypto.randomUUID(),
                workspace_id: wsId,
                chat_session_id: sessionId,
                role: "System",
                content: `Setup script failed: ${err}`,
                cost_usd: null, duration_ms: null,
                created_at: new Date().toISOString(),
                thinking: null,
                input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null,
          author_participant_id: null, author_display_name: null,
              });
            });
          } else {
            openModal("confirmSetupScript", {
              workspaceId: result.workspace.id,
              sessionId,
              repoId,
              script,
              source,
            });
          }
        }
      } catch {
        // No config or error reading it — no setup script to run.
      }
    } catch (e) {
      console.error("Failed to create workspace:", e);
      setCreatingWorkspace(null);
      alert(`Failed to create workspace: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      creatingRef.current = false;
    }
  }, [addWorkspace, selectWorkspace, addChatMessage, openModal, setCreatingWorkspace]);

  const filteredWorkspaces = useMemo(
    () => workspaces.filter((ws) => {
      if (ws.remote_connection_id) return false;
      if (!sidebarShowArchived && ws.status === "Archived") return false;
      if (sidebarRepoFilter !== "all" && ws.repository_id !== sidebarRepoFilter) return false;
      return true;
    }),
    [workspaces, sidebarShowArchived, sidebarRepoFilter]
  );

  // Workspaces in the order the sidebar actually renders them. Repos default
  // to the original auto-sort (SCM priority), and only switch to sort_order
  // after the user manually drags a workspace in that repo.
  const visuallyOrderedWorkspaces = useMemo(() => {
    const localRepos = repositories.filter((r) => !r.remote_connection_id);
    const repoIndex = new Map(localRepos.map((r, i) => [r.id, i]));
    const out: typeof workspaces = [];
    for (const repo of localRepos) {
      const repoWs = orderRepoWorkspaces(
        filteredWorkspaces.filter((ws) => ws.repository_id === repo.id),
        scmSummary,
        isManualWorkspaceOrder(manualWorkspaceOrderByRepo, repo.id),
      );
      out.push(...repoWs);
    }
    // Also include any workspaces whose repo isn't in `localRepos` (shouldn't
    // happen because filteredWorkspaces already excludes remote, but defends
    // against orphaned rows). Append in their existing relative order so the
    // hook can still hit-test them if rendered.
    for (const ws of filteredWorkspaces) {
      if (!repoIndex.has(ws.repository_id) && !out.includes(ws)) out.push(ws);
    }
    return out;
  }, [filteredWorkspaces, repositories, scmSummary, manualWorkspaceOrderByRepo]);

  const statusBuckets = useMemo(() => {
    const buckets = new Map<StatusBucketKey, typeof workspaces>();
    for (const key of STATUS_BUCKET_ORDER) buckets.set(key, []);
    for (const ws of filteredWorkspaces) {
      let key: StatusBucketKey;
      if (ws.status === "Archived") {
        key = "archived";
      } else {
        const summary = scmSummary[ws.id];
        if (!summary?.hasPr) {
          key = "in-progress";
        } else if (summary.prState === "merged") {
          key = "merged";
        } else if (summary.prState === "closed") {
          key = "closed";
        } else if (summary.prState === "draft") {
          key = "draft";
        } else {
          key = "in-review";
        }
      }
      buckets.get(key)!.push(ws);
    }
    return buckets;
  }, [filteredWorkspaces, scmSummary]);

  const handleArchive = useCallback(async (wsId: string) => {
    if (archivingRef.current.has(wsId)) return;
    archivingRef.current.add(wsId);

    try {
      const preState = useAppStore.getState();
      const ws = preState.workspaces.find((w) => w.id === wsId);
      const repo = ws ? preState.repositories.find((r) => r.id === ws.repository_id) : null;

      // If this repo has an archive script and the user hasn't opted into
      // auto-run, surface a confirmation modal so they can review the script
      // and choose to run it or skip. The modal handles the archive call
      // itself (and the optimistic update) — see ConfirmArchiveScriptModal.
      if (repo) {
        let script: string | null = repo.archive_script ?? null;
        let source: "repo" | "settings" = "settings";
        try {
          const config = await getRepoConfig(repo.id);
          if (config.archive_script) {
            script = config.archive_script;
            source = "repo";
          }
        } catch {
          // No config or error reading it — fall back to per-repo override.
        }
        if (script && !repo.archive_script_auto_run) {
          openModal("confirmArchiveScript", {
            workspaceId: wsId,
            repoId: repo.id,
            script,
            source,
          });
          return;
        }
      }

      // Re-read state after the await — selection or workspace data may have
      // changed while `getRepoConfig` was in flight. Using stale state here
      // would leave snapshot/restore acting on outdated data.
      const currentState = useAppStore.getState();
      const snapshot = currentState.workspaces.find((w) => w.id === wsId);
      const wasSelected = currentState.selectedWorkspaceId === wsId;

      updateWorkspace(wsId, {
        status: "Archived",
        worktree_path: null,
        agent_status: "Stopped",
      });
      if (wasSelected) selectWorkspace(null);

      try {
        const deleted = await archiveWorkspace(wsId);
        if (deleted) {
          removeWorkspace(wsId);
        }
      } catch (e) {
        console.error("Failed to archive workspace:", e);
        if (snapshot) {
          updateWorkspace(wsId, snapshot);
          // Only restore selection if the user hasn't navigated elsewhere
          // while the archive command was in flight.
          if (wasSelected && useAppStore.getState().selectedWorkspaceId === null) {
            selectWorkspace(wsId);
          }
        }
      }
    } finally {
      archivingRef.current.delete(wsId);
    }
  }, [updateWorkspace, removeWorkspace, selectWorkspace, openModal]);

  const handleRestore = useCallback(async (wsId: string) => {
    if (restoringRef.current.has(wsId)) return;
    restoringRef.current.add(wsId);
    try {
      const path = await restoreWorkspace(wsId);
      updateWorkspace(wsId, { status: "Active", worktree_path: path });
    } catch (e) {
      console.error("Failed to restore workspace:", e);
    } finally {
      restoringRef.current.delete(wsId);
    }
  }, [updateWorkspace]);

  const handleRenameSubmit = useCallback(async (wsId: string) => {
    const trimmed = renameValue.trim();
    const ws = workspaces.find((w) => w.id === wsId);
    if (!trimmed || trimmed === ws?.name) {
      setRenamingWsId(null);
      return;
    }
    try {
      await renameWorkspace(wsId, trimmed);
      updateWorkspace(wsId, { name: trimmed });
    } catch (e) {
      console.error("Failed to rename workspace:", e);
      addToast(t("rename_workspace_failed", { error: String(e) }));
    }
    setRenamingWsId(null);
  }, [renameValue, workspaces, updateWorkspace, addToast, t]);

  const workspaceContextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!workspaceContextMenu) return [];
    const ws = workspaces.find((w) => w.id === workspaceContextMenu.workspaceId);
    if (!ws) return [];
    return buildWorkspaceContextMenuItems(
      { status: ws.status, worktreePath: ws.worktree_path, remote: false },
      workspaceContextMenuLabels(t),
      {
        rename: () => {
          setRenamingWsId(ws.id);
          setRenameValue(ws.name);
        },
        markAsUnread: () => {
          markWorkspaceAsUnread(ws.id);
          addToast(t("context_marked_as_unread"));
        },
        openInFileManager: ws.worktree_path
          ? () => openInEditor(ws.worktree_path!)
          : undefined,
        openInTerminal: ws.worktree_path
          ? () => openWorkspaceInTerminal(ws.worktree_path!)
          : undefined,
        copyWorkingDirectory: ws.worktree_path
          ? async () => {
              await clipboardWriteText(ws.worktree_path!);
              addToast(t("context_copied_working_directory"));
            }
          : undefined,
        copyClaudeSessionId: async () => {
          const state = useAppStore.getState();
          let sessions = state.sessionsByWorkspace[ws.id] ?? [];
          let selectedSessionId = state.selectedSessionIdByWorkspaceId[ws.id];
          let claudeSessionId = pickClaudeSessionId(sessions, selectedSessionId);
          if (!claudeSessionId) {
            sessions = await listChatSessions(ws.id, false);
            setSessionsForWorkspace(ws.id, sessions);
            selectedSessionId =
              useAppStore.getState().selectedSessionIdByWorkspaceId[ws.id] ??
              selectedSessionId;
            claudeSessionId = pickClaudeSessionId(sessions, selectedSessionId);
          }
          if (!claudeSessionId) {
            addToast(t("context_no_claude_session_id"));
            return;
          }
          await clipboardWriteText(claudeSessionId);
          addToast(t("context_copied_claude_session_id"));
        },
        archive: ws.status === "Active" ? () => handleArchive(ws.id) : undefined,
        restore: ws.status === "Archived" ? () => handleRestore(ws.id) : undefined,
        delete:
          ws.status === "Archived"
            ? () =>
                openModal("deleteWorkspace", {
                  wsId: ws.id,
                  wsName: ws.name,
                })
            : undefined,
      },
    );
  }, [
    addToast,
    handleArchive,
    handleRestore,
    markWorkspaceAsUnread,
    openModal,
    setSessionsForWorkspace,
    t,
    workspaceContextMenu,
    workspaces,
  ]);

  // Drag-reorder for workspaces inside a repo group. Disabled in "by status"
  // grouping mode (option 2A — within-repo only): when the sidebar is grouped
  // by status, sibling workspaces in a status bucket can come from different
  // repos, so the within-repo invariant doesn't apply and we simply skip the
  // pointer handlers there.
  //
  // Items are the full filtered workspace list; isSameGroup enforces that a
  // dragged workspace can only land next to a sibling in the same repo. The
  // hook handles the visual feedback (drop indicator suppressed for invalid
  // targets) and the reorder math; the onReorder callback persists the new
  // per-repo order.
  const workspaceDrag = useTabDragReorder<typeof workspaces[number], string>({
    items: visuallyOrderedWorkspaces,
    dataAttr: "sidebarWorkspaceId",
    // Workspaces stack vertically, so the drop midpoint must be Y-axis.
    // Without this, dragging a workspace toward the bottom of its repo
    // group can never produce an "after" placement on the last sibling
    // (the cursor would have to leave the row to cross an X midpoint).
    orientation: "vertical",
    parseId: (raw) => raw,
    getId: (ws) => ws.id,
    getTitle: (ws) => ws.name,
    isSameGroup: (a, b) => a.repository_id === b.repository_id,
    onReorder: (next, draggedId) => {
      const moved = next.find((w) => w.id === draggedId);
      if (!moved) return;
      // Build the persistence sequence from the visible-order ids of the
      // moved repo, then APPEND any siblings in the same repo that the
      // current filter (e.g. "Show archived" off) hides. Without those
      // hidden tail entries, `reorder_workspaces` would leave them at
      // their stale sort_order — when the user toggles archived workspaces
      // back on, the archived rows could land mid-sequence with
      // duplicated/interleaved values (Copilot review of the second push).
      const visibleRepoIds = next
        .filter((w) => w.repository_id === moved.repository_id)
        .map((w) => w.id);
      const visibleSet = new Set(visibleRepoIds);
      const hiddenTailIds = workspaces
        .filter(
          (w) =>
            w.repository_id === moved.repository_id && !visibleSet.has(w.id),
        )
        // Stable order for hidden siblings: preserve their existing
        // sort_order so a later "show archived" toggle keeps them in the
        // same relative position they were in before the drag.
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((w) => w.id);
      const repoIds = [...visibleRepoIds, ...hiddenTailIds];
      const orderIndex = new Map(repoIds.map((id, i) => [id, i]));
      // Optimistic update: rewrite both the array order AND each
      // workspace's `sort_order` for the moved repo. Reordering the array
      // (not just the field) ensures a second drag in this repo runs the
      // hook against the post-drop sequence, not the stale pre-drag one
      // (Codex P2). Workspaces in other repos pass through untouched.
      const movedRepoIdSet = new Set(repoIds);
      const movedRepoUpdated = repoIds
        .map((id, i) => {
          const ws = workspaces.find((w) => w.id === id);
          return ws ? { ...ws, sort_order: i } : null;
        })
        .filter((w): w is (typeof workspaces)[number] => w !== null);
      const replacements = movedRepoUpdated[Symbol.iterator]();
      const optimistic = workspaces.map((w) => {
        if (movedRepoIdSet.has(w.id)) {
          const r = replacements.next();
          return r.done
            ? { ...w, sort_order: orderIndex.get(w.id) ?? w.sort_order }
            : r.value;
        }
        return w;
      });
      setWorkspaces(optimistic);
      markWorkspaceOrderManual(moved.repository_id);
      void reorderWorkspaces(moved.repository_id, repoIds).catch((err) =>
        console.error("[Sidebar] Failed to persist workspace order:", err),
      );
    },
  });

  const renderWorkspace = (ws: typeof workspaces[number], dragEnabled: boolean) => {
    const dragHandlers = dragEnabled ? workspaceDrag.getTabHandlers(ws) : null;
    const isDragging = dragEnabled && workspaceDrag.draggingId === ws.id;
    const dropBefore =
      dragEnabled &&
      workspaceDrag.dropTarget?.id === ws.id &&
      workspaceDrag.dropTarget.placement === "before";
    const dropAfter =
      dragEnabled &&
      workspaceDrag.dropTarget?.id === ws.id &&
      workspaceDrag.dropTarget.placement === "after";
    // Compute the unread/attention badge here only because the row's
    // `wsUnread` className depends on it. The actual icon rendering lives
    // in `WorkspaceStatusIcon`, which re-derives the same state — keeping
    // the duplication in sync isn't a concern because the inputs are the
    // same store slices and a divergence would surface immediately.
    const wsSessions = sessionsByWorkspace[ws.id] ?? [];
    const hasPlan = wsSessions.some((s) => s.needs_attention && s.attention_kind === "Plan");
    const hasQuestion = wsSessions.some((s) => s.needs_attention && s.attention_kind !== "Plan");
    const hasUnreadBadge =
      hasQuestion
      || hasPlan
      || (unreadCompletions.has(ws.id) && !isAgentBusy(ws.agent_status));
    return (
      <div
        key={ws.id}
        data-sidebar-workspace-id={dragEnabled ? ws.id : undefined}
        data-drop-before={dropBefore || undefined}
        data-drop-after={dropAfter || undefined}
        className={`${styles.wsItem} ${selectedWorkspaceId === ws.id ? styles.wsSelected : ""} ${hasUnreadBadge ? styles.wsUnread : ""} ${isDragging ? styles.wsDragging : ""}`}
        onClick={() => {
          if (dragEnabled && workspaceDrag.justEnded()) return;
          selectWorkspace(ws.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setRepoContextMenu(null);
          setWorkspaceContextMenu({
            workspaceId: ws.id,
            x: e.clientX,
            y: e.clientY,
          });
        }}
        onPointerDown={dragHandlers?.onPointerDown}
        onPointerMove={dragHandlers?.onPointerMove}
        onPointerUp={dragHandlers?.onPointerUp}
        onPointerCancel={dragHandlers?.onPointerCancel}
      >
        <WorkspaceStatusIcon workspace={ws} />
        <div className={styles.wsInfo}>
          {renamingWsId === ws.id ? (
            <input
              ref={renameInputRef}
              className={styles.wsNameInput}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => {
                if (renameCancelledRef.current) {
                  renameCancelledRef.current = false;
                  return;
                }
                handleRenameSubmit(ws.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRenameSubmit(ws.id);
                if (e.key === "Escape") {
                  renameCancelledRef.current = true;
                  setRenamingWsId(null);
                }
              }}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label={t("rename_workspace_aria")}
            />
          ) : (
            <span
              className={styles.wsName}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setRenamingWsId(ws.id);
                setRenameValue(ws.name);
              }}
            >
              {ws.name}
            </span>
          )}
          <span className={styles.wsBranch}>{ws.branch_name}</span>
          {(() => {
            if (!showSidebarRunningCommands) return null;
            const wsCommands = workspaceTerminalCommands[ws.id];
            if (!wsCommands) return null;
            const entries = Object.entries(wsCommands);
            if (entries.length === 0) return null;

            const truncateCommand = (cmd: string, maxLen: number) => {
              if (cmd.length <= maxLen) return cmd;
              return cmd.slice(0, maxLen - 3) + "...";
            };

            const expanded = expandedCommandWorkspaces.has(ws.id);
            const count = entries.length;
            const listId = `running-commands-${ws.id}`;

            return (
              <>
                <button
                  type="button"
                  className={styles.terminalCommandSummary}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCommandsExpanded(ws.id);
                  }}
                  title={expanded ? t("command_collapse") : t("command_expand")}
                  aria-expanded={expanded}
                  aria-controls={listId}
                >
                  <span className={styles.iconWrap} aria-label={t("command_running")}>
                    <Cog size={12} className={styles.runningIcon} />
                  </span>
                  <span className={styles.commandText}>
                    {t("command_count_running", { count })}
                  </span>
                  {expanded ? (
                    <ChevronDown size={10} className={styles.commandChevron} />
                  ) : (
                    <ChevronRight size={10} className={styles.commandChevron} />
                  )}
                </button>
                {expanded && (
                  <div id={listId} role="group" aria-label={t("command_running_commands")}>
                    {entries.map(([ptyId, command]) => (
                      <div key={ptyId} className={styles.terminalCommandItem}>
                        <span className={styles.commandText} title={command ?? ""}>
                          {truncateCommand(command ?? t("command_running_placeholder"), 40)}
                        </span>
                        <button
                          type="button"
                          className={styles.commandStopBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            void interruptPtyForeground(Number(ptyId)).catch((err) =>
                              console.error("[Sidebar] Failed to interrupt PTY command:", err),
                            );
                          }}
                          title={t("command_stop")}
                          aria-label={t("command_stop")}
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </div>
        <div className={styles.wsActions}>
          {ws.status === "Active" ? (
            <button
              className={styles.iconBtn}
              onClick={(e) => {
                e.stopPropagation();
                handleArchive(ws.id);
              }}
              title={t("archive_workspace")}
            >
              <Archive size={12} />
            </button>
          ) : (
            <>
              <button
                className={styles.iconBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRestore(ws.id);
                }}
                title={t("restore_workspace")}
              >
                ↺
              </button>
              <button
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                onClick={(e) => {
                  e.stopPropagation();
                  openModal("deleteWorkspace", {
                    wsId: ws.id,
                    wsName: ws.name,
                  });
                }}
                title={t("delete_workspace")}
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={styles.sidebar}>
      <div className={styles.header} data-tauri-drag-region>
        <span className={styles.title}>{t("sidebar_title")}</span>
        <div className={styles.headerActions}>
          <button
            className={styles.dashboardBtn}
            onClick={goToDashboard}
            title={t("back_to_dashboard")}
            aria-label={t("back_to_dashboard")}
          >
            <LayoutDashboard size={12} />
          </button>
          <div className={styles.filterDropdown} ref={filterDropdownRef}>
            <button
              className={styles.filterToggle}
              onClick={() => setFilterMenuOpen((open) => !open)}
              title={t("filter_workspaces")}
              aria-label={t("filter_workspaces")}
              aria-haspopup="dialog"
              aria-expanded={filterMenuOpen}
              aria-controls="workspace-filter-menu"
            >
              <Filter size={12} />
            </button>
          {filterMenuOpen && (
            <div className={styles.filterMenu} id="workspace-filter-menu" role="dialog" aria-label={t("workspace_filters_aria")}>
              <label className={styles.filterRow}>
                <span className={styles.filterLabel}>{t("filter_group_by")}</span>
                <select
                  className={styles.filterSelect}
                  value={sidebarGroupBy}
                  onChange={(e) => setSidebarGroupBy(e.target.value as "status" | "repo")}
                >
                  <option value="status">{t("filter_group_by_status")}</option>
                  <option value="repo">{t("filter_group_by_repo")}</option>
                </select>
              </label>
              <label className={styles.filterRow}>
                <span className={styles.filterLabel}>{t("filter_repo_label")}</span>
                <select
                  className={styles.filterSelect}
                  value={sidebarRepoFilter}
                  onChange={(e) => setSidebarRepoFilter(e.target.value)}
                >
                  <option value="all">{t("filter_all_repos")}</option>
                  {repositories
                    .filter((r) => !r.remote_connection_id)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className={`${styles.filterRow} ${styles.filterCheckboxRow}`}>
                <input
                  type="checkbox"
                  checked={sidebarShowArchived}
                  onChange={(e) => setSidebarShowArchived(e.target.checked)}
                />
                <span className={styles.filterLabel}>{t("filter_show_archived")}</span>
              </label>
            </div>
          )}
          </div>
        </div>
      </div>

      <div className={styles.list}>
        {sidebarGroupBy === "status" && STATUS_BUCKET_ORDER.map((key) => {
          const bucketWorkspaces = statusBuckets.get(key) ?? [];
          if (bucketWorkspaces.length === 0) return null;
          const groupKey = `status:${key}`;
          const collapsed = statusGroupCollapsed[groupKey];
          const runningCount = bucketWorkspaces.filter((ws) => isAgentBusy(ws.agent_status)).length;
          let label: string;
          switch (key) {
            case "merged": label = t("status_merged"); break;
            case "in-review": label = t("status_in_review"); break;
            case "draft": label = t("status_draft"); break;
            case "in-progress": label = t("status_in_progress"); break;
            case "closed": label = t("status_closed"); break;
            case "archived": label = t("status_archived"); break;
            default: label = key;
          }
          return (
            <div key={groupKey} className={styles.statusGroup}>
              <div
                className={styles.statusGroupHeader}
                onClick={() => toggleStatusGroupCollapsed(groupKey)}
              >
                <span className={styles.chevron}>{collapsed ? "›" : "⌄"}</span>
                <span className={styles.repoName}>
                  {label}
                  {runningCount > 0 && (
                    <span className={styles.runningBadge}>{runningCount}</span>
                  )}
                  <span className={styles.statusGroupCount}>{bucketWorkspaces.length}</span>
                </span>
              </div>
              {!collapsed && bucketWorkspaces.map((ws) => renderWorkspace(ws, false))}
            </div>
          );
        })}

        {sidebarGroupBy === "status" && filteredWorkspaces.length === 0 && (() => {
          const localRepos = repositories.filter((r) => !r.remote_connection_id);
          const hasHiddenArchived =
            !sidebarShowArchived &&
            workspaces.some(
              (ws) =>
                !ws.remote_connection_id &&
                ws.status === "Archived" &&
                (sidebarRepoFilter === "all" || ws.repository_id === sidebarRepoFilter)
            );
          const repoFilterActive = sidebarRepoFilter !== "all";
          const hasNoWorkspaces = !workspaces.some((ws) => !ws.remote_connection_id);
          const targetRepo = repoFilterActive
            ? localRepos.find((r) => r.id === sidebarRepoFilter && r.path_valid)
            : localRepos.find((r) => r.path_valid);

          let message: string;
          if (hasHiddenArchived && repoFilterActive) {
            message = t("no_workspaces_archived_for_repo");
          } else if (hasHiddenArchived) {
            message = t("no_workspaces_all_archived");
          } else if (hasNoWorkspaces && localRepos.length === 0) {
            message = t("no_repos");
          } else if (hasNoWorkspaces) {
            message = t("no_workspaces");
          } else if (repoFilterActive) {
            message = t("no_workspaces_repo_filter");
          } else {
            message = t("nothing_to_show");
          }

          return (
            <div className={styles.emptyState}>
              <div className={styles.emptyStateMessage}>{message}</div>
              <div className={styles.emptyStateActions}>
                {hasHiddenArchived && (
                  <button
                    className={styles.emptyStateAction}
                    onClick={() => setSidebarShowArchived(true)}
                  >
                    {t("filter_show_archived")}
                  </button>
                )}
                {repoFilterActive && (
                  <button
                    className={styles.emptyStateAction}
                    onClick={() => setSidebarRepoFilter("all")}
                  >
                    {t("clear_repo_filter")}
                  </button>
                )}
                {hasNoWorkspaces && targetRepo && (
                  <button
                    className={styles.emptyStateAction}
                    onClick={() => handleCreateWorkspace(targetRepo.id)}
                  >
                    {t("new_workspace")}
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {sidebarGroupBy === "repo" && repositories
          .filter((r) => !r.remote_connection_id)
          .filter((r) => sidebarRepoFilter === "all" || r.id === sidebarRepoFilter)
          .map((repo, repoIdx) => {
          const collapsed = repoCollapsed[repo.id];
          const repoWorkspaces = orderRepoWorkspaces(
            filteredWorkspaces.filter((ws) => ws.repository_id === repo.id),
            scmSummary,
            isManualWorkspaceOrder(manualWorkspaceOrderByRepo, repo.id),
          );
          const runningCount = repoWorkspaces.filter(
            (ws) => isAgentBusy(ws.agent_status)
          ).length;
          const jumpActionId = repoIdx < 9
            ? (`global.jump-to-project-${repoIdx + 1}` as HotkeyActionId)
            : null;
          const jumpShortcut = jumpActionId
            ? getHotkeyLabel(jumpActionId, keybindings, isMac)
            : null;
          const jumpLabel =
            t("jump_to_project", { number: repoIdx + 1 }) ?? "";
          const jumpTooltip = jumpActionId && jumpShortcut && jumpLabel
            ? tooltipWithHotkey(
                jumpLabel,
                jumpActionId,
                keybindings,
                isMac,
              )
            : undefined;

          return (
            <div
              key={repo.id}
              ref={(el) => {
                if (el) repoGroupRefs.current.set(repo.id, el);
                else repoGroupRefs.current.delete(repo.id);
              }}
              className={`${styles.repoGroup} ${draggedRepoId === repo.id ? styles.dragging : ""} ${dropTargetIdx === repoIdx && draggedRepoId && draggedRepoId !== repo.id ? styles.dropTarget : ""}`}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                // Don't initiate drag from interactive elements (buttons, links).
                const target = e.target as HTMLElement;
                if (target.closest("button, a, input, select")) return;
                const header = target.closest(`.${styles.repoHeader}`);
                if (!header) return;
                // Record start position — don't activate drag until threshold
                dragStartPos.current = { x: e.clientX, y: e.clientY, id: repo.id, pointerId: e.pointerId };
              }}
              onPointerMove={(e) => {
                if (!dragStartPos.current) return;
                if (dragStartPos.current.id !== repo.id) return;

                // Activate drag after threshold
                if (!draggedRepoId) {
                  const dx = e.clientX - dragStartPos.current.x;
                  const dy = e.clientY - dragStartPos.current.y;
                  if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
                  e.currentTarget.setPointerCapture(dragStartPos.current.pointerId);
                  setDraggedRepoId(repo.id);
                  didDragRef.current = true;
                  // Prevent text selection while dragging
                  window.getSelection()?.removeAllRanges();
                }
                e.preventDefault();

                // Hit-test: find which repo the pointer is over using midpoint
                const localRepos = repositories.filter((r) => !r.remote_connection_id);
                let targetIdx: number | null = null;
                for (let i = 0; i < localRepos.length; i++) {
                  const el = repoGroupRefs.current.get(localRepos[i].id);
                  if (!el) continue;
                  const rect = el.getBoundingClientRect();
                  const mid = rect.top + rect.height / 2;
                  if (e.clientY < mid) {
                    targetIdx = i;
                    break;
                  }
                  targetIdx = i + 1;
                }
                // Clamp and skip if same position
                if (targetIdx !== null) {
                  const fromIdx = localRepos.findIndex((r) => r.id === repo.id);
                  if (targetIdx === fromIdx || targetIdx === fromIdx + 1) targetIdx = null;
                }
                setDropTargetIdx(targetIdx);
              }}
              onPointerUp={() => {
                const wasActive = draggedRepoId === repo.id;
                if (wasActive && dropTargetIdx !== null) {
                  const localRepos = repositories.filter((r) => !r.remote_connection_id);
                  const fromIdx = localRepos.findIndex((r) => r.id === repo.id);
                  if (fromIdx >= 0) {
                    const reordered = [...localRepos];
                    const [moved] = reordered.splice(fromIdx, 1);
                    const insertIdx = dropTargetIdx > fromIdx ? dropTargetIdx - 1 : dropTargetIdx;
                    reordered.splice(insertIdx, 0, moved);
                    setRepositories([
                      ...reordered,
                      ...repositories.filter((r) => !!r.remote_connection_id),
                    ]);
                    reorderRepositories(reordered.map((r) => r.id)).catch(console.error);
                  }
                }
                dragStartPos.current = null;
                setDraggedRepoId(null);
                setDropTargetIdx(null);
                // Reset didDrag after click fires (click follows pointerup).
                if (didDragRef.current) {
                  requestAnimationFrame(() => { didDragRef.current = false; });
                }
              }}
              onPointerCancel={() => {
                dragStartPos.current = null;
                setDraggedRepoId(null);
                setDropTargetIdx(null);
              }}
              onPointerLeave={() => {
                // Without eager pointer capture, pointerup may not fire if the
                // pointer leaves before the drag threshold. Clear stale state.
                if (!draggedRepoId && dragStartPos.current?.id === repo.id) {
                  dragStartPos.current = null;
                }
              }}
            >
              {draggedRepoId && dropTargetIdx === repoIdx && draggedRepoId !== repo.id && (
                <div className={styles.dropIndicator} />
              )}
              <div
                className={`${styles.repoHeader} ${selectedRepositoryId === repo.id && !selectedWorkspaceId ? styles.repoHeaderSelected : ""}`}
                data-tooltip={jumpTooltip}
                data-tooltip-placement="bottom"
                onClick={() => {
                  if (didDragRef.current) return;
                  // Standard tree-view pattern: header click selects the
                  // project (showing the project-scoped view) and ALWAYS
                  // ensures the group is expanded so the user can see
                  // what's inside. Toggling collapse on every click
                  // (the previous behaviour) was bizarre because clicking
                  // a project to "look at it" hid the very rows the user
                  // wanted to look at. The chevron handles collapse on
                  // its own — see the button below.
                  selectRepository(repo.id);
                  if (collapsed) toggleRepoCollapsed(repo.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setRepoContextMenu({
                    repoId: repo.id,
                    x: e.clientX,
                    y: e.clientY,
                  });
                }}
              >
                <button
                  type="button"
                  className={styles.chevron}
                  onClick={(e) => {
                    // Stop the parent header click — the chevron is the
                    // dedicated collapse affordance, separate from select.
                    e.stopPropagation();
                    toggleRepoCollapsed(repo.id);
                  }}
                  aria-label={
                    collapsed
                      ? t("expand_repo_aria", { name: repo.name })
                      : t("collapse_repo_aria", { name: repo.name })
                  }
                  aria-expanded={!collapsed}
                >
                  {collapsed ? "›" : "⌄"}
                </button>
                <span className={styles.repoName}>
                  {repo.icon && <RepoIcon icon={repo.icon} className={styles.repoIcon} />}
                  <span className={styles.repoTitle}>{repo.name}</span>
                  {runningCount > 0 && (
                    <span className={styles.runningBadge}>{runningCount}</span>
                  )}
                </span>
                {!repo.path_valid && (
                  <span className={styles.invalidBadge}>!</span>
                )}
                {repo.path_valid ? (
                  <>
                    <button
                      className={styles.iconBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCreateWorkspace(repo.id);
                      }}
                      title={t("new_workspace")}
                    >
                      +
                    </button>
                    <button
                      className={styles.iconBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        openSettings(`repo:${repo.id}`);
                      }}
                      title={t("settings")}
                    >
                      <Settings size={12} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className={styles.iconBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        openModal("relinkRepo", {
                          repoId: repo.id,
                          repoName: repo.name,
                        });
                      }}
                      title={t("relink")}
                    >
                      <Link size={12} />
                    </button>
                    <button
                      className={styles.iconBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        openModal("removeRepo", {
                          repoId: repo.id,
                          repoName: repo.name,
                        });
                      }}
                      title={t("remove")}
                    >
                      <X size={12} />
                    </button>
                  </>
                )}
                {jumpShortcut && (
                  <kbd
                    aria-hidden="true"
                    className={`${styles.shortcutBadge} ${metaKeyHeld ? styles.shortcutBadgeVisible : ""}`}
                  >
                    {jumpShortcut}
                  </kbd>
                )}
              </div>

              {!collapsed && repoWorkspaces.map((ws) => renderWorkspace(ws, true))}
              {/* Show loading workspace while creating */}
              {!collapsed && creatingWorkspace && creatingWorkspace.repoId === repo.id && (
                <div className={`${styles.wsItem} ${styles.wsItemLoading}`}>
                  <span className={styles.statusSpinner} aria-hidden="true">
                    <span className={styles.statusSpinnerRing} />
                  </span>
                  <div className={styles.wsInfo}>
                    <span className={`${styles.wsName} ${styles.wsNamePlaceholder}`}>
                      {t("creating_workspace")}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {sidebarGroupBy === "repo" && draggedRepoId && dropTargetIdx === repositories.filter((r) => !r.remote_connection_id).length && (
          <div className={styles.dropIndicator} />
        )}

        <RemoteSections />
      </div>

      <UpdateBanner />

      <div className={styles.footer}>
        <button
          className={styles.footerBtn}
          onClick={() => openModal("addRepo")}
          title={t("add_repository")}
        >
          <Plus size={16} />
        </button>
        <button
          className={styles.footerBtn}
          onClick={() => openModal("addRemote")}
          title={t("add_remote")}
        >
          <Globe size={16} />
        </button>
        <ShareButton openModal={openModal} />
        <HelpMenu
          buttonClassName={styles.footerBtn}
          triggerLabel={t("help_menu_trigger")}
        />
        <button
          className={styles.footerBtn}
          onClick={() => openSettings()}
          {...tooltipAttributes(t("settings"), "global.open-settings", keybindings, isMac)}
          aria-label={t("settings")}
        >
          <Settings size={16} />
        </button>
      </div>
      {workspaceDrag.dragGhost && workspaceDrag.draggingId !== null && (
        <TabDragGhost ghost={workspaceDrag.dragGhost} />
      )}
      {repoContextMenu && (
        <ContextMenu
          x={repoContextMenu.x}
          y={repoContextMenu.y}
          items={repoContextMenuItems}
          onClose={() => setRepoContextMenu(null)}
          dataTestId="repo-context-menu"
        />
      )}
      {workspaceContextMenu && workspaceContextMenuItems.length > 0 && (
        <ContextMenu
          x={workspaceContextMenu.x}
          y={workspaceContextMenu.y}
          items={workspaceContextMenuItems}
          onClose={() => setWorkspaceContextMenu(null)}
          dataTestId="workspace-context-menu"
        />
      )}
    </div>
  );
});

export function RemoteSections() {
  const { t } = useTranslation("sidebar");
  const discoveredServers = useAppStore((s) => s.discoveredServers);
  const remoteConnections = useAppStore((s) => s.remoteConnections);
  const activeRemoteIds = useAppStore((s) => s.activeRemoteIds);
  const addRemote = useAppStore((s) => s.addRemoteConnection);
  const addActiveId = useAppStore((s) => s.addActiveRemoteId);
  const removeActiveId = useAppStore((s) => s.removeActiveRemoteId);
  const removeRemote = useAppStore((s) => s.removeRemoteConnection);
  const mergeRemoteData = useAppStore((s) => s.mergeRemoteData);
  const clearRemoteData = useAppStore((s) => s.clearRemoteData);
  const unpaired = discoveredServers.filter((s) => !s.is_paired);
  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());
  const [connectError, setConnectError] = useState<string | null>(null);

  const handleConnect = async (id: string) => {
    setConnectError(null);
    setConnectingIds((prev) => new Set(prev).add(id));
    try {
      const data = await connectRemote(id);
      addActiveId(id);
      if (data) {
        mergeRemoteData(id, data);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setConnectError(msg);
      console.error("Failed to connect:", e);
    } finally {
      setConnectingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleDisconnect = async (id: string) => {
    try {
      await disconnectRemote(id);
      removeActiveId(id);
      clearRemoteData(id);
    } catch (e) {
      console.error("Failed to disconnect:", e);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await removeRemoteConnection(id);
      removeRemote(id);
      clearRemoteData(id);
    } catch (e) {
      console.error("Failed to remove remote connection:", e);
    }
  };

  const handlePair = async (host: string, port: number) => {
    const token = prompt("Enter pairing token:");
    if (!token) return;
    try {
      const result = await pairWithServer(host, port, token);
      addRemote(result.connection);
      addActiveId(result.connection.id);
      if (result.initial_data) {
        mergeRemoteData(result.connection.id, result.initial_data);
      }
    } catch (e) {
      console.error("Failed to pair:", e);
    }
  };

  if (unpaired.length === 0 && remoteConnections.length === 0) return null;

  return (
    <>
      {unpaired.length > 0 && (
        <div className={styles.remoteSection}>
          <div className={`${styles.repoHeader} ${styles.remoteHeader}`}>
            <span className={`${styles.repoName} ${styles.sectionLabel}`}>
              {t("nearby_section")}
            </span>
          </div>
          {unpaired.map((server) => (
            <div key={`${server.host}:${server.port}`} className={styles.wsItem}>
              <span className={`${styles.statusDot} ${styles.remoteStatusIdle}`} />
              <div className={styles.wsInfo}>
                <span className={styles.wsName}>{server.name || server.host}</span>
                <span className={styles.wsBranch}>{server.host}</span>
              </div>
              <button
                className={`${styles.iconBtn} ${styles.smallBtn}`}
                onClick={() => handlePair(server.host, server.port)}
                title={t("workspace_connect")}
              >
                {t("workspace_connect")}
              </button>
            </div>
          ))}
        </div>
      )}

      {remoteConnections.length > 0 && (
        <div className={styles.remoteSection}>
          {connectError && (
            <div className={styles.connectError}>{connectError}</div>
          )}
          {remoteConnections.map((conn) => {
            const isActive = activeRemoteIds.includes(conn.id);
            const isConnecting = connectingIds.has(conn.id);
            return (
              <RemoteConnectionGroup
                key={conn.id}
                conn={conn}
                isActive={isActive}
                isConnecting={isConnecting}
                onConnect={() => handleConnect(conn.id)}
                onDisconnect={() => handleDisconnect(conn.id)}
                onRemove={() => handleRemove(conn.id)}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

function RemoteConnectionGroup({
  conn,
  isActive,
  isConnecting,
  onConnect,
  onDisconnect,
  onRemove,
}: {
  conn: import("../../types/remote").RemoteConnectionInfo;
  isActive: boolean;
  isConnecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("sidebar");
  const repositories = useAppStore((s) => s.repositories);
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const markWorkspaceAsUnread = useAppStore((s) => s.markWorkspaceAsUnread);
  const addToast = useAppStore((s) => s.addToast);
  const repoCollapsed = useAppStore((s) => s.repoCollapsed);
  const toggleRepoCollapsed = useAppStore((s) => s.toggleRepoCollapsed);
  const creatingRef = useRef<Set<string>>(new Set());
  const archivingRef = useRef<Set<string>>(new Set());
  const [workspaceContextMenu, setWorkspaceContextMenu] = useState<{
    workspaceId: string;
    x: number;
    y: number;
  } | null>(null);

  const remoteRepos = repositories.filter(
    (r) => r.remote_connection_id === conn.id
  );
  const remoteWorkspaces = workspaces.filter(
    (w) => w.remote_connection_id === conn.id
  );

  const handleCreateWorkspace = async (repoId: string) => {
    if (creatingRef.current.has(repoId)) return;
    creatingRef.current.add(repoId);
    try {
      const generated = await generateWorkspaceName();
      const result = await sendRemoteCommand(conn.id, "create_workspace", {
        repository_id: repoId,
        name: generated.slug,
      });
      // Server's create_workspace was changed in the ops-core extraction
      // (Phase 1) to wrap the row under `workspace` so it can also carry
      // `default_session_id` and `setup_result`. Accept both shapes —
      // bare Workspace (legacy) and the new wrapper — so older servers
      // and the new one both work.
      const wsPayload = extractRemoteWorkspace(result);
      if (!wsPayload) {
        throw new Error("Remote server returned an invalid workspace");
      }
      const ws: import("../../types/workspace").Workspace = {
        ...wsPayload,
        remote_connection_id: conn.id,
      };
      addWorkspace(ws);
      selectWorkspace(ws.id);
    } catch (e) {
      console.error("Failed to create remote workspace:", e);
    } finally {
      creatingRef.current.delete(repoId);
    }
  };

  const handleArchive = useCallback(async (wsId: string) => {
    if (archivingRef.current.has(wsId)) return;
    archivingRef.current.add(wsId);
    try {
      await sendRemoteCommand(conn.id, "archive_workspace", {
        workspace_id: wsId,
      });
      updateWorkspace(wsId, {
        status: "Archived",
        worktree_path: null,
        agent_status: "Stopped",
      });
      if (selectedWorkspaceId === wsId) selectWorkspace(null);
    } catch (e) {
      console.error("Failed to archive remote workspace:", e);
    } finally {
      archivingRef.current.delete(wsId);
    }
  }, [conn.id, selectedWorkspaceId, selectWorkspace, updateWorkspace]);

  const workspaceContextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!workspaceContextMenu) return [];
    const ws = remoteWorkspaces.find(
      (candidate) => candidate.id === workspaceContextMenu.workspaceId,
    );
    if (!ws) return [];
    return buildWorkspaceContextMenuItems(
      { status: ws.status, worktreePath: null, remote: true },
      workspaceContextMenuLabels(t),
      {
        markAsUnread: () => {
          markWorkspaceAsUnread(ws.id);
          addToast(t("context_marked_as_unread"));
        },
        archive: ws.status === "Active" ? () => handleArchive(ws.id) : undefined,
      },
    );
  }, [
    addToast,
    handleArchive,
    markWorkspaceAsUnread,
    remoteWorkspaces,
    t,
    workspaceContextMenu,
  ]);

  return (
    <div className={styles.repoGroup}>
      {/* Connection header */}
      <div className={`${styles.repoHeader} ${styles.remoteConnectionHeader}`}>
        <span
          className={`${styles.statusDot} ${styles.remoteStatusDot} ${
            isConnecting
              ? styles.remoteStatusIdle
              : isActive
                ? styles.remoteStatusActive
                : styles.remoteStatusStopped
          }`}
        />
        <span className={`${styles.repoName} ${styles.sectionLabel}`}>
          <span className={styles.repoTitle}>{conn.name}</span>
        </span>
        {!isActive && !isConnecting && (
          <button
            className={`${styles.iconBtn} ${styles.smallBtnDim}`}
            onClick={onRemove}
            title={t("remote_remove")}
          >
            <X size={12} />
          </button>
        )}
        <button
          className={`${styles.iconBtn} ${isConnecting ? styles.smallBtnConnecting : styles.smallBtn}`}
          onClick={() => (isActive ? onDisconnect() : onConnect())}
          disabled={isConnecting}
          title={isConnecting ? t("workspace_connecting") : isActive ? t("workspace_disconnect") : t("workspace_connect")}
        >
          {isConnecting ? "…" : isActive ? "×" : "→"}
        </button>
      </div>

      {/* Remote repos and their workspaces */}
      {isActive &&
        remoteRepos.map((repo) => {
          const collapsed = repoCollapsed[repo.id];
          const repoWs = remoteWorkspaces.filter(
            (ws) => ws.repository_id === repo.id && ws.status === "Active"
          );
          const runningCount = repoWs.filter(
            (ws) => ws.agent_status === "Running"
          ).length;

          return (
            <div key={repo.id}>
              <div
                className={`${styles.repoHeader} ${styles.remoteRepoHeader}`}
                onClick={() => toggleRepoCollapsed(repo.id)}
              >
                <span className={styles.chevron}>
                  {collapsed ? "›" : "⌄"}
                </span>
                <span className={styles.repoName}>
                  {repo.icon && (
                    <RepoIcon icon={repo.icon} className={styles.repoIcon} />
                  )}
                  <span className={styles.repoTitle}>{repo.name}</span>
                  {runningCount > 0 && (
                    <span className={styles.runningBadge}>{runningCount}</span>
                  )}
                </span>
                <button
                  className={styles.iconBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCreateWorkspace(repo.id);
                  }}
                  title={t("new_workspace_remote")}
                >
                  +
                </button>
              </div>
              {!collapsed &&
                repoWs.map((ws) => (
                  <div
                    key={ws.id}
                    className={`${styles.wsItem} ${selectedWorkspaceId === ws.id ? styles.wsSelected : ""}`}
                    onClick={() => selectWorkspace(ws.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setWorkspaceContextMenu({
                        workspaceId: ws.id,
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }}
                  >
                    <WorkspaceStatusIcon workspace={ws} />
                    <div className={styles.wsInfo}>
                      <span className={styles.wsName}>{ws.name}</span>
                      <span className={styles.wsBranch}>{ws.branch_name}</span>
                    </div>
                    <div className={styles.wsActions}>
                      <button
                        className={styles.iconBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleArchive(ws.id);
                        }}
                        title={t("archive_workspace")}
                      >
                        <Archive size={12} />
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          );
        })}

      {/* Show placeholder when connected but no repos */}
      {isActive && remoteRepos.length === 0 && (
        <div className={`${styles.wsItem} ${styles.remotePlaceholder}`}>
          <div className={styles.wsInfo}>
            <span className={styles.wsName}>{t("no_remote_repos")}</span>
          </div>
        </div>
      )}
      {workspaceContextMenu && workspaceContextMenuItems.length > 0 && (
        <ContextMenu
          x={workspaceContextMenu.x}
          y={workspaceContextMenu.y}
          items={workspaceContextMenuItems}
          onClose={() => setWorkspaceContextMenu(null)}
          dataTestId="remote-workspace-context-menu"
        />
      )}
    </div>
  );
}

function ShareButton({ openModal }: { openModal: (name: string) => void }) {
  // The button now just *opens* the share UI. Starting/stopping the
  // server is the modal's job — the canonical place where the user mints
  // workspace-scoped shares and sees their connection strings. Auto-
  // starting the legacy unscoped server here was a footgun: the new
  // server's startup banner no longer prints `claudette://...` (every
  // share mints its own), so the old auto-start path would time out.
  //
  // Active styling reads from `activeSharesCount` (the workspace-scoped
  // shares count, hydrated at startup and kept in sync by ShareModal's
  // refresh). The legacy `localServerRunning` flag is no longer the
  // canonical "is sharing on" indicator — under the new model a share
  // can be live without that legacy server running.
  const { t } = useTranslation("sidebar");
  const activeSharesCount = useAppStore((s) => s.activeSharesCount);
  const active = activeSharesCount > 0;
  return (
    <button
      className={`${styles.footerBtn}${active ? ` ${styles.shareBtnActive}` : ""}`}
      onClick={() => openModal("share")}
      title={active ? t("share_active_title") : t("share_inactive_title")}
    >
      <Share2 size={16} />
    </button>
  );
}
