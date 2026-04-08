import { useRef, useState, useMemo, useCallback } from "react";
import { useAppStore } from "../../stores/useAppStore";
import {
  archiveWorkspace,
  restoreWorkspace,
  generateWorkspaceName,
  createWorkspace,
  connectRemote,
  disconnectRemote,
  removeRemoteConnection,
  sendRemoteCommand,
  pairWithServer,
  startLocalServer,
} from "../../services/tauri";
import { Settings, Link, X, Share2, Plus, Globe } from "lucide-react";
import { RepoIcon } from "../shared/RepoIcon";
import styles from "./Sidebar.module.css";


export function Sidebar() {
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
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const unreadCompletions = useAppStore((s) => s.unreadCompletions);
  const clearUnreadCompletion = useAppStore((s) => s.clearUnreadCompletion);

  const creatingRef = useRef(false);

  const handleCreateWorkspace = useCallback(async (repoId: string) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      const generated = await generateWorkspaceName();
      const result = await createWorkspace(repoId, generated.slug);
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
        });
      }
      if (result.setup_result) {
        const sr = result.setup_result;
        const label = sr.source === "repo" ? ".claudette.json" : "settings";
        const status = sr.success ? "completed" : sr.timed_out ? "timed out" : "failed";
        addChatMessage(result.workspace.id, {
          id: crypto.randomUUID(),
          workspace_id: result.workspace.id,
          role: "System",
          content: `Setup script (${label}) ${status}${sr.output ? `:\n${sr.output}` : ""}`,
          cost_usd: null,
          duration_ms: null,
          created_at: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error("Failed to create workspace:", e);
    } finally {
      creatingRef.current = false;
    }
  }, [addWorkspace, selectWorkspace, addChatMessage]);

  const filteredWorkspaces = useMemo(
    () => workspaces.filter((ws) => {
      if (sidebarFilter === "active") return ws.status === "Active";
      if (sidebarFilter === "archived") return ws.status === "Archived";
      return true;
    }),
    [workspaces, sidebarFilter]
  );

  const handleArchive = useCallback(async (wsId: string) => {
    try {
      await archiveWorkspace(wsId);
      updateWorkspace(wsId, {
        status: "Archived",
        worktree_path: null,
        agent_status: "Stopped",
      });
      if (useAppStore.getState().selectedWorkspaceId === wsId) selectWorkspace(null);
    } catch {
      // ignore
    }
  }, [updateWorkspace, selectWorkspace]);

  const handleRestore = useCallback(async (wsId: string) => {
    try {
      const path = await restoreWorkspace(wsId);
      updateWorkspace(wsId, { status: "Active", worktree_path: path });
    } catch {
      // ignore
    }
  }, [updateWorkspace]);

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.title}>Workspaces</span>
      </div>

      <div className={styles.filters}>
        {(["all", "active", "archived"] as const).map((f) => (
          <button
            key={f}
            className={`${styles.filterBtn} ${sidebarFilter === f ? styles.filterActive : ""}`}
            onClick={() => setSidebarFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <div className={styles.list}>
        {repositories.filter((r) => !r.remote_connection_id).map((repo) => {
          const collapsed = repoCollapsed[repo.id];
          const repoWorkspaces = filteredWorkspaces.filter(
            (ws) => ws.repository_id === repo.id
          );
          const runningCount = repoWorkspaces.filter(
            (ws) => ws.agent_status === "Running"
          ).length;

          return (
            <div key={repo.id} className={styles.repoGroup}>
              <div
                className={styles.repoHeader}
                onClick={() => toggleRepoCollapsed(repo.id)}
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
                        openModal("repoSettings", { repoId: repo.id });
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
              </div>

              {!collapsed &&
                repoWorkspaces.map((ws) => {
                  const hasUnread = unreadCompletions.has(ws.id);
                  return (
                  <div
                    key={ws.id}
                    className={`${styles.wsItem} ${selectedWorkspaceId === ws.id ? styles.wsSelected : ""} ${hasUnread ? styles.wsUnread : ""}`}
                    onClick={() => {
                      selectWorkspace(ws.id);
                      if (hasUnread) {
                        clearUnreadCompletion(ws.id);
                      }
                    }}
                  >
                    <span
                      className={`${styles.statusDot} ${ws.agent_status === "Running" ? styles.statusDotRunning : ""}`}
                      style={{
                        background:
                          ws.agent_status === "Running"
                            ? "var(--status-running)"
                            : ws.agent_status === "Stopped"
                              ? "var(--status-stopped)"
                              : "var(--status-idle)",
                      }}
                    />
                    <div className={styles.wsInfo}>
                      <span className={styles.wsName}>
                        {ws.name}
                        {hasUnread && <span className={styles.notificationBadge}>●</span>}
                      </span>
                      <span className={styles.wsBranch}>{ws.branch_name}</span>
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
                          <X size={12} />
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
                            className={styles.iconBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              openModal("deleteWorkspace", {
                                wsId: ws.id,
                                wsName: ws.name,
                              });
                            }}
                            title="Delete"
                          >
                            <X size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  );
                })}
            </div>
          );
        })}
      </div>

      <RemoteSections />

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
          onClick={() => openModal("appSettings")}
          title="Settings"
        >
          <Settings size={14} />
        </button>
      </div>
    </div>
  );
}

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
        <div className={styles.list} style={{ borderTop: "1px solid var(--border-subtle)" }}>
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
        <div className={styles.list} style={{ borderTop: "1px solid var(--border-subtle)" }}>
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
                    <span
                      className={`${styles.statusDot} ${ws.agent_status === "Running" ? styles.statusDotRunning : ""}`}
                      style={{
                        background:
                          ws.agent_status === "Running"
                            ? "var(--status-running)"
                            : ws.agent_status === "Stopped"
                              ? "var(--status-stopped)"
                              : "var(--status-idle)",
                      }}
                    />
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
                        <X size={12} />
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
