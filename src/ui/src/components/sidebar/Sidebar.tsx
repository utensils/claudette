import { memo, useRef, useState, useMemo, useCallback, useEffect } from "react";
import { useAppStore } from "../../stores/useAppStore";
import {
  archiveWorkspace,
  reorderRepositories,
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
import { Settings, Link, X, Share2, Plus, Globe, Archive, Trash2, BadgeCheck, BadgeInfo, BadgeQuestionMark, Cog, Filter, Check, LayoutDashboard, GitPullRequestArrow, GitPullRequestDraft, GitMerge, GitPullRequestClosed } from "lucide-react";
import { RepoIcon } from "../shared/RepoIcon";
import { useSpinnerFrame } from "../../hooks/useSpinnerFrame";
import styles from "./Sidebar.module.css";

export const Sidebar = memo(function Sidebar() {
  const repositories = useAppStore((s) => s.repositories);
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const sidebarFilter = useAppStore((s) => s.sidebarFilter);
  const setSidebarFilter = useAppStore((s) => s.setSidebarFilter);
  const repoCollapsed = useAppStore((s) => s.repoCollapsed);
  const toggleRepoCollapsed = useAppStore((s) => s.toggleRepoCollapsed);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const openModal = useAppStore((s) => s.openModal);
  const openSettings = useAppStore((s) => s.openSettings);
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const unreadCompletions = useAppStore((s) => s.unreadCompletions);
  const agentQuestions = useAppStore((s) => s.agentQuestions);
  const planApprovals = useAppStore((s) => s.planApprovals);
  const scmSummary = useAppStore((s) => s.scmSummary);
  const setRepositories = useAppStore((s) => s.setRepositories);
  const metaKeyHeld = useAppStore((s) => s.metaKeyHeld);
  const remoteConnections = useAppStore((s) => s.remoteConnections);
  const discoveredServers = useAppStore((s) => s.discoveredServers);
  const isMac = navigator.platform.startsWith("Mac");

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

  const anyRunning = useMemo(
    () => workspaces.some((ws) => ws.agent_status === "Running"),
    [workspaces],
  );
  const spinnerChar = useSpinnerFrame(anyRunning);

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
      if (generated.message) {
        addChatMessage(result.workspace.id, {
          id: crypto.randomUUID(),
          workspace_id: result.workspace.id,
          role: "System",
          content: generated.message,
          cost_usd: null,
          duration_ms: null,
          created_at: new Date().toISOString(),
          thinking: null,
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
                addChatMessage(wsId, {
                  id: crypto.randomUUID(),
                  workspace_id: wsId,
                  role: "System",
                  content: `Setup script (${lbl}) ${status}${sr.output ? `:\n${sr.output}` : ""}`,
                  cost_usd: null, duration_ms: null,
                  created_at: new Date().toISOString(),
                  thinking: null,
                });
              }
            }).catch((err) => {
              addChatMessage(wsId, {
                id: crypto.randomUUID(),
                workspace_id: wsId,
                role: "System",
                content: `Setup script failed: ${err}`,
                cost_usd: null, duration_ms: null,
                created_at: new Date().toISOString(),
                thinking: null,
              });
            });
          } else {
            openModal("confirmSetupScript", {
              workspaceId: result.workspace.id,
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
    } finally {
      creatingRef.current = false;
    }
  }, [addWorkspace, selectWorkspace, addChatMessage, openModal]);

  const filteredWorkspaces = useMemo(
    () => workspaces.filter((ws) => {
      if (sidebarFilter === "active") return ws.status === "Active";
      if (sidebarFilter === "archived") return ws.status === "Archived";
      return true;
    }),
    [workspaces, sidebarFilter]
  );

  const handleArchive = useCallback(async (wsId: string) => {
    if (archivingRef.current.has(wsId)) return;
    archivingRef.current.add(wsId);
    try {
      await archiveWorkspace(wsId);
      updateWorkspace(wsId, {
        status: "Archived",
        worktree_path: null,
        agent_status: "Stopped",
      });
      if (useAppStore.getState().selectedWorkspaceId === wsId) selectWorkspace(null);
    } catch (e) {
      console.error("Failed to archive workspace:", e);
    } finally {
      archivingRef.current.delete(wsId);
    }
  }, [updateWorkspace, selectWorkspace]);

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

  return (
    <div className={styles.sidebar}>
      <div className={styles.header} data-tauri-drag-region>
        <span className={styles.title}>Workspaces</span>
        <div className={styles.headerActions}>
          <button
            className={styles.dashboardBtn}
            onClick={() => selectWorkspace(null)}
            title="Back to dashboard"
            aria-label="Back to dashboard"
          >
            <LayoutDashboard size={12} />
          </button>
          <div className={styles.filterDropdown} ref={filterDropdownRef}>
            <button
              className={styles.filterToggle}
              onClick={() => setFilterMenuOpen((open) => !open)}
              title="Filter workspaces"
              aria-label="Filter workspaces"
              aria-haspopup="menu"
              aria-expanded={filterMenuOpen}
              aria-controls="workspace-filter-menu"
            >
              <Filter size={12} />
            </button>
          {filterMenuOpen && (
            <div className={styles.filterMenu} id="workspace-filter-menu" role="menu">
              <button
                className={styles.filterMenuItem}
                onClick={() => {
                  setSidebarFilter("all");
                  setFilterMenuOpen(false);
                }}
                role="menuitem"
              >
                <span>All</span>
                {sidebarFilter === "all" && <Check size={14} />}
              </button>
              <button
                className={styles.filterMenuItem}
                onClick={() => {
                  setSidebarFilter("active");
                  setFilterMenuOpen(false);
                }}
                role="menuitem"
              >
                <span>Active</span>
                {sidebarFilter === "active" && <Check size={14} />}
              </button>
              <button
                className={styles.filterMenuItem}
                onClick={() => {
                  setSidebarFilter("archived");
                  setFilterMenuOpen(false);
                }}
                role="menuitem"
              >
                <span>Archived</span>
                {sidebarFilter === "archived" && <Check size={14} />}
              </button>
              {(remoteConnections.length > 0 || discoveredServers.length > 0) && (
                <button
                  className={styles.filterMenuItem}
                  onClick={() => {
                    setSidebarFilter("remote");
                    setFilterMenuOpen(false);
                  }}
                  role="menuitem"
                >
                  <span>Remote</span>
                  {sidebarFilter === "remote" && <Check size={14} />}
                </button>
              )}
            </div>
          )}
          </div>
        </div>
      </div>

      <div className={styles.list}>
        {sidebarFilter !== "remote" && repositories.filter((r) => !r.remote_connection_id).map((repo, repoIdx) => {
          const collapsed = repoCollapsed[repo.id];
          const repoWorkspaces = filteredWorkspaces.filter(
            (ws) => ws.repository_id === repo.id
          );
          const runningCount = repoWorkspaces.filter(
            (ws) => ws.agent_status === "Running"
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
                      title="New workspace"
                    >
                      +
                    </button>
                    <button
                      className={styles.iconBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        openSettings(`repo:${repo.id}`);
                      }}
                      title="Settings"
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
                      title="Re-link"
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
                      title="Remove"
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

              {!collapsed &&
                repoWorkspaces.map((ws) => {
                  const badge: "ask" | "plan" | "done" | null =
                    agentQuestions[ws.id] ? "ask" :
                    planApprovals[ws.id] ? "plan" :
                    unreadCompletions.has(ws.id) && ws.agent_status !== "Running" ? "done" :
                    null;
                  return (
                  <div
                    key={ws.id}
                    className={`${styles.wsItem} ${selectedWorkspaceId === ws.id ? styles.wsSelected : ""} ${badge ? styles.wsUnread : ""}`}
                    onClick={() => {
                      selectWorkspace(ws.id);
                    }}
                  >
                    {badge === "done" ? (
                      <span className={styles.badgeDone} title="Completed" aria-label="Completed" role="img">
                        <BadgeCheck size={14} />
                      </span>
                    ) : badge === "plan" ? (
                      <span className={styles.badgePlan} title="Plan approval needed" aria-label="Plan approval needed" role="img">
                        <BadgeInfo size={14} />
                      </span>
                    ) : badge === "ask" ? (
                      <span className={styles.badgeAsk} title="Question requires attention" aria-label="Question requires attention" role="img">
                        <BadgeQuestionMark size={14} />
                      </span>
                    ) : ws.agent_status === "Running" ? (
                      <span className={styles.statusSpinner} aria-hidden="true">
                        {spinnerChar}
                      </span>
                    ) : (
                      <span
                        className={styles.statusDot}
                        style={{
                          background:
                            ws.agent_status === "Stopped"
                              ? "var(--status-stopped)"
                              : "var(--status-idle)",
                        }}
                      />
                    )}
                    <div className={styles.wsInfo}>
                      <span className={styles.wsName}>
                        {ws.name}
                      </span>
                      <span className={styles.wsBranch}>
                        {ws.branch_name}
                        {(() => {
                          const summary = scmSummary[ws.id];
                          if (!summary?.hasPr || ws.agent_status === "Running") return null;
                          const prState = summary.prState;
                          const ciState = summary.ciState;
                          const Icon = prState === "merged" ? GitMerge
                            : prState === "closed" ? GitPullRequestClosed
                            : prState === "draft" ? GitPullRequestDraft
                            : GitPullRequestArrow;
                          const color = prState === "merged" ? "var(--purple, #a855f7)"
                            : prState === "closed" ? "var(--red, #ef4444)"
                            : prState === "draft" ? "var(--text-dim)"
                            : ciState === "failure" ? "var(--red, #ef4444)"
                            : ciState === "pending" ? "var(--yellow, #eab308)"
                            : "var(--green, #22c55e)";
                          const titleText = `PR: ${prState}${ciState ? `, CI: ${ciState}` : ""}`;
                          return <span title={titleText} style={{ display: "inline-flex", marginLeft: 4, flexShrink: 0 }}><Icon size={11} style={{ color }} /></span>;
                        })()}
                      </span>
                      {(() => {
                        const commandState = workspaceTerminalCommands[ws.id];
                        if (!commandState?.command) return null;

                        const truncateCommand = (cmd: string, maxLen: number) => {
                          if (cmd.length <= maxLen) return cmd;
                          return cmd.slice(0, maxLen - 3) + "...";
                        };

                        return (
                          <div className={styles.terminalCommand}>
                            {commandState.isRunning ? (
                              <span title="Running" aria-label="Running">
                                <Cog size={12} className={styles.runningIcon} />
                              </span>
                            ) : commandState.exitCode === 0 ? (
                              <span className={styles.successIcon} title="Exited successfully">✓</span>
                            ) : commandState.exitCode !== null ? (
                              <span className={styles.errorIcon} title={`Exit code: ${commandState.exitCode}`}>✗</span>
                            ) : (
                              <span className={styles.commandIcon}>▸</span>
                            )}
                            <span className={styles.commandText} title={commandState.command}>
                              {truncateCommand(commandState.command, 40)}
                            </span>
                          </div>
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
                          title="Archive"
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
                            title="Restore"
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
                            title="Delete"
                          >
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  );
                })}
              {/* Show loading workspace while creating */}
              {!collapsed && creatingWorkspace && creatingWorkspace.repoId === repo.id && (
                <div className={`${styles.wsItem} ${styles.wsItemLoading}`}>
                  <span className={styles.statusSpinner} aria-hidden="true">
                    {spinnerChar}
                  </span>
                  <div className={styles.wsInfo}>
                    <span className={styles.wsName} style={{ opacity: 0.5 }}>
                      Creating workspace...
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {sidebarFilter !== "remote" && draggedRepoId && dropTargetIdx === repositories.filter((r) => !r.remote_connection_id).length && (
          <div className={styles.dropIndicator} />
        )}

        {sidebarFilter === "all" || sidebarFilter === "remote" ? <RemoteSections /> : null}
      </div>

      <div className={styles.footer}>
        <button
          className={styles.footerBtn}
          onClick={() => openModal("addRepo")}
          title="Add repository"
        >
          <Plus size={14} />
        </button>
        <button
          className={styles.footerBtn}
          onClick={() => openModal("addRemote")}
          title="Add remote"
        >
          <Globe size={14} />
        </button>
        <ShareButton openModal={openModal} />
        <button
          className={styles.footerBtn}
          onClick={() => openSettings()}
          title="Settings"
        >
          <Settings size={14} />
        </button>
      </div>
    </div>
  );
});

function RemoteSections() {
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
        <div style={{ borderTop: "1px solid var(--border-subtle)" }}>
          <div className={styles.repoHeader} style={{ opacity: 0.7, cursor: "default" }}>
            <span className={styles.repoName} style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Nearby
            </span>
          </div>
          {unpaired.map((server) => (
            <div key={`${server.host}:${server.port}`} className={styles.wsItem}>
              <span className={styles.statusDot} style={{ background: "var(--status-idle)" }} />
              <div className={styles.wsInfo}>
                <span className={styles.wsName}>{server.name || server.host}</span>
                <span className={styles.wsBranch}>{server.host}</span>
              </div>
              <button
                className={styles.iconBtn}
                onClick={() => handlePair(server.host, server.port)}
                title="Connect"
                style={{ fontSize: 11 }}
              >
                Connect
              </button>
            </div>
          ))}
        </div>
      )}

      {remoteConnections.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border-subtle)" }}>
          {connectError && (
            <div style={{ padding: "4px 12px", fontSize: 11, color: "var(--status-error, #f55)", lineHeight: 1.3 }}>
              {connectError}
            </div>
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

  const anyRunning = remoteWorkspaces.some((ws) => ws.agent_status === "Running");
  const spinnerChar = useSpinnerFrame(anyRunning);

  const handleCreateWorkspace = async (repoId: string) => {
    if (creatingRef.current.has(repoId)) return;
    creatingRef.current.add(repoId);
    try {
      const name = await generateWorkspaceName();
      const result = await sendRemoteCommand(conn.id, "create_workspace", {
        repository_id: repoId,
        name,
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
      <div className={styles.repoHeader} style={{ opacity: 0.8 }}>
        <span
          className={styles.statusDot}
          style={{
            background: isConnecting
              ? "var(--status-idle)"
              : isActive
                ? "var(--status-running)"
                : "var(--status-stopped)",
            marginRight: 4,
          }}
        />
        <span className={styles.repoName} style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.5px" }}>
          {conn.name}
        </span>
        {!isActive && !isConnecting && (
          <button
            className={styles.iconBtn}
            onClick={onRemove}
            title="Remove"
            style={{ fontSize: 11, opacity: 0.5 }}
          >
            <X size={12} />
          </button>
        )}
        <button
          className={styles.iconBtn}
          onClick={() => (isActive ? onDisconnect() : onConnect())}
          disabled={isConnecting}
          title={isConnecting ? "Connecting…" : isActive ? "Disconnect" : "Connect"}
          style={{ fontSize: 11, opacity: isConnecting ? 0.5 : 1 }}
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
                className={styles.repoHeader}
                onClick={() => toggleRepoCollapsed(repo.id)}
                style={{ paddingLeft: 12 }}
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
                  title="New workspace"
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
                    {ws.agent_status === "Running" ? (
                      <span className={styles.statusSpinner} aria-hidden="true">
                        {spinnerChar}
                      </span>
                    ) : (
                      <span
                        className={styles.statusDot}
                        style={{
                          background:
                            ws.agent_status === "Stopped"
                              ? "var(--status-stopped)"
                              : "var(--status-idle)",
                        }}
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
                        title="Archive"
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
        <div className={styles.wsItem} style={{ opacity: 0.5 }}>
          <div className={styles.wsInfo}>
            <span className={styles.wsName}>No repositories</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ShareButton({ openModal }: { openModal: (name: string) => void }) {
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
      className={styles.footerBtn}
      onClick={handleClick}
      title={running ? "Sharing — click to view connection string" : "Share this machine"}
      disabled={loading}
      style={running ? { color: "var(--status-running)" } : undefined}
    >
      <Share2 size={14} />
    </button>
  );
}
