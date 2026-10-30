import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, X } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { isAgentBusy } from "../../utils/agentStatus";
import { generateWorkspaceName, sendRemoteCommand } from "../../services/tauri";
import type { RemoteConnectionInfo } from "../../types/remote";
import type { Workspace } from "../../types/workspace";
import { RepoIcon } from "../shared/RepoIcon";
import { ContextMenu, type ContextMenuItem } from "../shared/ContextMenu";
import { extractRemoteWorkspace } from "./remoteWorkspaceResponse";
import {
  buildWorkspaceContextMenuItems,
  workspaceContextMenuLabels,
} from "./workspaceContextMenu";
import {
  connectRemoteConnection,
  disconnectRemoteConnection,
  forgetRemoteConnection,
  isCertificateMismatch,
  needsRepair,
} from "./remoteConnectionActions";
import { stopReconnecting } from "../../hooks/useRemoteConnectionLifecycle";
import styles from "./Sidebar.module.css";

/** "Nearby" (unpaired mDNS servers) and saved remote connections. */
export function RemoteSections() {
  const { t } = useTranslation("sidebar");
  const { t: tModals } = useTranslation("modals");
  const discoveredServers = useAppStore((s) => s.discoveredServers);
  const remoteConnections = useAppStore((s) => s.remoteConnections);
  const activeRemoteIds = useAppStore((s) => s.activeRemoteIds);
  const reconnectingRemoteIds = useAppStore((s) => s.reconnectingRemoteIds);
  const openModal = useAppStore((s) => s.openModal);
  const addToast = useAppStore((s) => s.addToast);
  const unpaired = discoveredServers.filter((s) => !s.is_paired);
  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());
  const [connectError, setConnectError] = useState<string | null>(null);

  const openPairModal = (
    host: string,
    port: number,
    name: string,
    fingerprintPrefix?: string,
  ) => openModal("pairRemote", { host, port, name, fingerprintPrefix });

  const handleConnect = async (conn: RemoteConnectionInfo) => {
    setConnectError(null);
    setConnectingIds((prev) => new Set(prev).add(conn.id));
    try {
      await connectRemoteConnection(conn.id);
    } catch (e) {
      if (needsRepair(e)) {
        // New certificate (reinstalled, regenerated) or this device's
        // session was revoked. Re-pairing with the server's token updates
        // the same entry.
        openPairModal(conn.host, conn.port, conn.name);
        setConnectError(
          t(
            isCertificateMismatch(e)
              ? "remote_certificate_changed"
              : "remote_needs_repair",
            { name: conn.name },
          ),
        );
      } else {
        setConnectError(String(e));
      }
    } finally {
      setConnectingIds((prev) => {
        const next = new Set(prev);
        next.delete(conn.id);
        return next;
      });
    }
  };

  const handleDisconnect = async (id: string) => {
    try {
      await disconnectRemoteConnection(id);
    } catch (e) {
      addToast(t("remote_action_failed", { error: String(e) }));
    }
  };

  /** Stop background retries; like a disconnect, this turns off
   *  auto-connect until the user connects again. */
  const handleCancelReconnect = async (id: string) => {
    stopReconnecting(id);
    await handleDisconnect(id);
  };

  const handleRemove = async (conn: RemoteConnectionInfo) => {
    stopReconnecting(conn.id);
    try {
      const result = await forgetRemoteConnection(conn.id);
      if (!result.revoked) {
        addToast(
          t("remote_revoke_failed", {
            name: conn.name,
            error: result.revoke_error ?? "",
            reset: tModals("share_reset"),
          }),
        );
      }
    } catch (e) {
      addToast(t("remote_action_failed", { error: String(e) }));
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
                onClick={() =>
                  openPairModal(
                    server.host,
                    server.port,
                    server.name || server.host,
                    server.cert_fingerprint_prefix,
                  )
                }
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
          {remoteConnections.map((conn) => (
            <RemoteConnectionGroup
              key={conn.id}
              conn={conn}
              isActive={activeRemoteIds.includes(conn.id)}
              isConnecting={connectingIds.has(conn.id)}
              isReconnecting={reconnectingRemoteIds.includes(conn.id)}
              onConnect={() => handleConnect(conn)}
              onDisconnect={() => handleDisconnect(conn.id)}
              onCancelReconnect={() => handleCancelReconnect(conn.id)}
              onRemove={() => handleRemove(conn)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function RemoteConnectionGroup({
  conn,
  isActive,
  isConnecting,
  isReconnecting,
  onConnect,
  onDisconnect,
  onCancelReconnect,
  onRemove,
}: {
  conn: RemoteConnectionInfo;
  isActive: boolean;
  /** A connect the user started is in flight. */
  isConnecting: boolean;
  /** A background reconnect is pending; the user can cancel it. */
  isReconnecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onCancelReconnect: () => void;
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
      // Accept both the `{workspace, default_session_id, ...}` wrapper and
      // the bare row older servers return.
      const wsPayload = extractRemoteWorkspace(result);
      if (!wsPayload) {
        throw new Error("Remote server returned an invalid workspace");
      }
      const ws: Workspace = {
        ...wsPayload,
        remote_connection_id: conn.id,
      };
      addWorkspace(ws);
      selectWorkspace(ws.id);
    } catch (e) {
      addToast(t("remote_action_failed", { error: String(e) }));
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
      addToast(t("remote_action_failed", { error: String(e) }));
    } finally {
      archivingRef.current.delete(wsId);
    }
  }, [addToast, conn.id, selectedWorkspaceId, selectWorkspace, t, updateWorkspace]);

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
            isConnecting || isReconnecting
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
        {isReconnecting && !isConnecting ? (
          <button
            className={`${styles.iconBtn} ${styles.smallBtnConnecting}`}
            onClick={onCancelReconnect}
            title={t("remote_cancel_reconnect")}
            aria-label={t("remote_cancel_reconnect")}
          >
            …
          </button>
        ) : (
          <button
            className={`${styles.iconBtn} ${isConnecting ? styles.smallBtnConnecting : styles.smallBtn}`}
            onClick={() => (isActive ? onDisconnect() : onConnect())}
            disabled={isConnecting}
            title={isConnecting ? t("workspace_connecting") : isActive ? t("workspace_disconnect") : t("workspace_connect")}
          >
            {isConnecting ? "…" : isActive ? "×" : "→"}
          </button>
        )}
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
