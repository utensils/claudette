import { memo, useRef, useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { isAgentBusy } from "../../utils/agentStatus";
import {
  archiveWorkspace,
  reorderRepositories,
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
  startLocalServer,
} from "../../services/tauri";
import { Settings, Link, X, Share2, Plus, Globe, Archive, Trash2, CircleCheck, CircleAlert, CircleQuestionMark, Cog, Filter, LayoutDashboard, CircleDashed, CircleStop, GitPullRequestArrow, GitPullRequestDraft, GitMerge, GitPullRequestClosed, ChevronRight, ChevronDown } from "lucide-react";
import { RepoIcon } from "../shared/RepoIcon";
import { UpdateBanner } from "../layout/UpdateBanner";
import { getScmSortPriority } from "../../utils/scmSortPriority";
import { useTabDragReorder } from "../../hooks/useTabDragReorder";
import { TabDragGhost } from "../shared/TabDragGhost";
import { reorderWorkspaces } from "../../services/tauri";
import styles from "./Sidebar.module.css";

type StatusBucketKey = "in-progress" | "in-review" | "draft" | "merged" | "closed" | "archived";
const STATUS_BUCKET_ORDER: StatusBucketKey[] = [
  "merged", "in-review", "draft", "in-progress", "closed", "archived",
];

export const Sidebar = memo(function Sidebar() {
  const repositories = useAppStore((s) => s.repositories);
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
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
  const addToast = useAppStore((s) => s.addToast);
  const unreadCompletions = useAppStore((s) => s.unreadCompletions);
  const agentQuestions = useAppStore((s) => s.agentQuestions);
  const planApprovals = useAppStore((s) => s.planApprovals);
  const sessionsByWorkspace = useAppStore((s) => s.sessionsByWorkspace);
  const scmSummary = useAppStore((s) => s.scmSummary);
  const setRepositories = useAppStore((s) => s.setRepositories);
  const setWorkspaces = useAppStore((s) => s.setWorkspaces);
  const metaKeyHeld = useAppStore((s) => s.metaKeyHeld);
  const isMac = navigator.platform.startsWith("Mac");
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
  const [creatingWorkspace, setCreatingWorkspace] = useState<{ repoId: string } | null>(null);

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
  }, [addWorkspace, selectWorkspace, addChatMessage, openModal]);

  const filteredWorkspaces = useMemo(
    () => workspaces.filter((ws) => {
      if (ws.remote_connection_id) return false;
      if (!sidebarShowArchived && ws.status === "Archived") return false;
      if (sidebarRepoFilter !== "all" && ws.repository_id !== sidebarRepoFilter) return false;
      return true;
    }),
    [workspaces, sidebarShowArchived, sidebarRepoFilter]
  );

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

    const initialState = useAppStore.getState();
    const snapshot = initialState.workspaces.find((w) => w.id === wsId);
    const wasSelected = initialState.selectedWorkspaceId === wsId;

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
    } finally {
      archivingRef.current.delete(wsId);
    }
  }, [updateWorkspace, removeWorkspace, selectWorkspace]);

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
    items: filteredWorkspaces,
    dataAttr: "sidebarWorkspaceId",
    parseId: (raw) => raw,
    getId: (ws) => ws.id,
    getTitle: (ws) => ws.name,
    isSameGroup: (a, b) => a.repository_id === b.repository_id,
    onReorder: (next, draggedId) => {
      const moved = next.find((w) => w.id === draggedId);
      if (!moved) return;
      // Persist only the moved workspace's repo. Other repos' relative
      // ordering hasn't changed (cross-group is rejected upstream by
      // isSameGroup), so we leave them alone.
      const repoIds = next
        .filter((w) => w.repository_id === moved.repository_id)
        .map((w) => w.id);
      // Optimistic local update: assign sort_order = position-within-repo
      // for the moved repo's workspaces so the sort comparator picks up
      // the new order on the next render. Other repos pass through.
      const orderIndex = new Map(repoIds.map((id, i) => [id, i]));
      const optimistic = workspaces.map((w) =>
        w.repository_id === moved.repository_id
          ? { ...w, sort_order: orderIndex.get(w.id) ?? w.sort_order }
          : w,
      );
      setWorkspaces(optimistic);
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
    const wsSessions = sessionsByWorkspace[ws.id] ?? [];
    const hasQuestion = wsSessions.some((s) => agentQuestions[s.id]);
    const hasPlan = wsSessions.some((s) => planApprovals[s.id]);
    const badge: "ask" | "plan" | "done" | null =
      hasQuestion ? "ask" :
      hasPlan ? "plan" :
      unreadCompletions.has(ws.id) && !isAgentBusy(ws.agent_status) ? "done" :
      null;
    return (
      <div
        key={ws.id}
        data-sidebar-workspace-id={dragEnabled ? ws.id : undefined}
        data-drop-before={dropBefore || undefined}
        data-drop-after={dropAfter || undefined}
        className={`${styles.wsItem} ${selectedWorkspaceId === ws.id ? styles.wsSelected : ""} ${badge ? styles.wsUnread : ""} ${isDragging ? styles.wsDragging : ""}`}
        onClick={() => {
          if (dragEnabled && workspaceDrag.justEnded()) return;
          selectWorkspace(ws.id);
        }}
        onPointerDown={dragHandlers?.onPointerDown}
        onPointerMove={dragHandlers?.onPointerMove}
        onPointerUp={dragHandlers?.onPointerUp}
        onPointerCancel={dragHandlers?.onPointerCancel}
      >
        {badge === "done" ? (
          <span className={styles.badgeDone} title={t("status_badge_completed_title")} aria-label={t("status_badge_completed_aria")} role="img">
            <CircleCheck size={14} />
          </span>
        ) : badge === "plan" ? (
          <span className={styles.badgePlan} title={t("status_badge_plan_title")} aria-label={t("status_badge_plan_aria")} role="img">
            <CircleAlert size={14} />
          </span>
        ) : badge === "ask" ? (
          <span className={styles.badgeAsk} title={t("status_badge_ask_title")} aria-label={t("status_badge_ask_aria")} role="img">
            <CircleQuestionMark size={14} />
          </span>
        ) : ws.agent_status === "Running" || ws.agent_status === "Compacting" ? (
          <span
            className={styles.statusSpinner}
            aria-hidden="true"
            title={ws.agent_status === "Compacting" ? t("status_compacting") : t("status_running")}
          >
            <span className={styles.statusSpinnerRing} />
          </span>
        ) : (() => {
          if (ws.status === "Archived") {
            return (
              <span className={styles.statusIcon} title={t("status_archived_title")}>
                <Archive size={14} style={{ color: "var(--text-dim)" }} />
              </span>
            );
          }
          const summary = scmSummary[ws.id];
          if (summary?.hasPr) {
            const prState = summary.prState;
            const ciState = summary.ciState;
            const Icon = prState === "merged" ? GitMerge
              : prState === "closed" ? GitPullRequestClosed
              : prState === "draft" ? GitPullRequestDraft
              : GitPullRequestArrow;
            const color = prState === "merged" ? "var(--badge-plan)"
              : prState === "closed" ? "var(--status-stopped)"
              : prState === "draft" ? "var(--text-dim)"
              : ciState === "failure" ? "var(--status-stopped)"
              : ciState === "pending" ? "var(--badge-ask)"
              : "var(--badge-done)";
            const titleText = `PR: ${prState}${ciState ? `, CI: ${ciState}` : ""}`;
            return (
              <span className={styles.statusIcon} title={titleText}>
                <Icon size={14} style={{ color }} />
              </span>
            );
          }
          return ws.agent_status === "Stopped" ? (
            <span className={styles.statusIcon} title={t("status_stopped")}>
              <CircleStop size={14} style={{ color: "var(--status-stopped)" }} />
            </span>
          ) : (
            <span className={styles.statusIcon} title={t("status_idle")}>
              <CircleDashed size={14} style={{ color: "var(--text-dim)" }} />
            </span>
          );
        })()}
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
            onClick={() => selectWorkspace(null)}
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
          // Sort by user-defined order (sort_order) as authoritative; fall
          // back to SCM priority only as a tiebreaker so workspaces seeded
          // with the same sort_order value (legacy DBs pre-migration) keep
          // their previous "by PR state" arrangement.
          const repoWorkspaces = filteredWorkspaces
            .filter((ws) => ws.repository_id === repo.id)
            .sort((a, b) => {
              if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
              return getScmSortPriority(scmSummary[a.id]) - getScmSortPriority(scmSummary[b.id]);
            });
          const runningCount = repoWorkspaces.filter(
            (ws) => isAgentBusy(ws.agent_status)
          ).length;

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
                className={styles.repoHeader}
                onClick={() => { if (!didDragRef.current) toggleRepoCollapsed(repo.id); }}
              >
                <span className={styles.chevron}>
                  {collapsed ? "›" : "⌄"}
                </span>
                <span className={styles.repoName}>
                  {repo.icon && <RepoIcon icon={repo.icon} className={styles.repoIcon} />}
                  {repo.name}
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
                {repoIdx < 9 && (
                  <kbd aria-hidden="true" className={`${styles.shortcutBadge} ${metaKeyHeld ? styles.shortcutBadgeVisible : ""}`}>
                    {isMac ? "⌘" : "Ctrl+"}{repoIdx + 1}
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
        <button
          className={styles.footerBtn}
          onClick={() => openSettings()}
          title={t("settings")}
        >
          <Settings size={16} />
        </button>
      </div>
      {workspaceDrag.dragGhost && workspaceDrag.draggingId !== null && (
        <TabDragGhost ghost={workspaceDrag.dragGhost} />
      )}
    </div>
  );
});

function RemoteSections() {
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
  const repoCollapsed = useAppStore((s) => s.repoCollapsed);
  const toggleRepoCollapsed = useAppStore((s) => s.toggleRepoCollapsed);
  const creatingRef = useRef<Set<string>>(new Set());
  const archivingRef = useRef<Set<string>>(new Set());

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
      if (result === null || typeof result !== "object" || !("id" in result)) {
        throw new Error("Remote server returned an invalid workspace");
      }
      const ws: import("../../types/workspace").Workspace = {
        ...(result as Omit<import("../../types/workspace").Workspace, "remote_connection_id">),
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

  const handleArchive = async (wsId: string) => {
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
  };

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
          {conn.name}
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
                  {repo.name}
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
                  >
                    {isAgentBusy(ws.agent_status) ? (
                      <span className={styles.statusSpinner} aria-hidden="true">
                        <span className={styles.statusSpinnerRing} />
                      </span>
                    ) : (
                      <span
                        className={`${styles.statusDot} ${
                          ws.agent_status === "Stopped"
                            ? styles.remoteStatusStopped
                            : styles.remoteStatusIdle
                        }`}
                      />
                    )}
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
    </div>
  );
}

function ShareButton({ openModal }: { openModal: (name: string) => void }) {
  const { t } = useTranslation("sidebar");
  const running = useAppStore((s) => s.localServerRunning);
  const setRunning = useAppStore((s) => s.setLocalServerRunning);
  const setConnectionString = useAppStore((s) => s.setLocalServerConnectionString);
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (running) {
      openModal("share");
      return;
    }

    setLoading(true);
    try {
      const info = await startLocalServer();
      setRunning(true);
      setConnectionString(info.connection_string);
      openModal("share");
    } catch (e) {
      console.error("Failed to start server:", e);
      alert(`Failed to start server: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      className={`${styles.footerBtn}${running ? ` ${styles.shareBtnActive}` : ""}`}
      onClick={handleClick}
      title={running ? t("share_active_title") : t("share_inactive_title")}
      disabled={loading}
    >
      <Share2 size={16} />
    </button>
  );
}
