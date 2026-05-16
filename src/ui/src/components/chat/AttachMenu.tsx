import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Paperclip, Settings } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import {
  loadRepositoryMcps,
  ensureAndValidateMcps,
  setMcpServerEnabled,
  getMcpStatus,
  reconnectMcpServer,
} from "../../services/mcp";
import type { SavedMcpServer, McpConnectionState, McpSource } from "../../types/mcp";
import { MCP_SOURCE_LABELS } from "../../types/mcp";
import styles from "./AttachMenu.module.css";

interface AttachMenuProps {
  repoId: string | undefined;
  onAttachFiles: () => void;
  onClose: () => void;
  isRemote: boolean;
}

function dotColor(state: McpConnectionState | undefined): string {
  switch (state) {
    case "connected":
      return "var(--status-running)";
    case "failed":
      return "var(--status-stopped)";
    case "disabled":
      return "var(--text-faint)";
    case "pending":
    default:
      return "var(--status-idle)";
  }
}

export function AttachMenu({
  repoId,
  onAttachFiles,
  onClose,
  isRemote,
}: AttachMenuProps) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const fileDialogAvailable = useAppStore((s) => s.fileDialogAvailable);
  const browseAvailable = fileDialogAvailable !== false;
  const mcpStatus = useAppStore((s) =>
    repoId ? s.mcpStatus[repoId] : undefined,
  );
  const setMcpStatus = useAppStore((s) => s.setMcpStatus);
  const openSettings = useAppStore((s) => s.openSettings);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);

  const [servers, setServers] = useState<SavedMcpServer[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  // On mount: auto-detect + validate, then load DB rows for toggle state.
  // Chained (not parallel) so loadRepositoryMcps reads after ensure has written.
  useEffect(() => {
    if (!repoId) return;
    const id = repoId;
    ensureAndValidateMcps(id)
      .then((snapshot) => {
        setMcpStatus(id, snapshot);
      })
      .catch(() => {})
      .finally(() => {
        loadRepositoryMcps(id).then(setServers).catch(() => {});
      });
  }, [repoId, setMcpStatus]);

  // Close on Escape.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleToggle = useCallback(
    async (server: SavedMcpServer, enabled: boolean) => {
      if (!repoId) return;
      try {
        await setMcpServerEnabled(server.id, repoId, server.name, enabled);
        const [updatedServers, snap] = await Promise.all([
          loadRepositoryMcps(repoId),
          getMcpStatus(repoId),
        ]);
        setServers(updatedServers);
        if (snap) setMcpStatus(repoId, snap);
      } catch (err) {
        console.error("Failed to toggle MCP server:", err);
      }
    },
    [repoId, setMcpStatus],
  );

  const handleReconnect = useCallback(
    async (serverName: string) => {
      if (!repoId) return;
      try {
        await reconnectMcpServer(repoId, serverName);
        const snap = await getMcpStatus(repoId);
        if (snap) setMcpStatus(repoId, snap);
      } catch (err) {
        console.error("Failed to reconnect MCP server:", err);
      }
    },
    [repoId, setMcpStatus],
  );

  const handleManage = useCallback(() => {
    if (!repoId) return;
    onClose();
    openSettings();
    setSettingsSection(`repo:${repoId}`);
  }, [repoId, onClose, openSettings, setSettingsSection]);

  const hasServers = servers.length > 0;

  return (
    <>
      <div className={styles.overlay} onClick={onClose} />
      <div ref={menuRef} className={styles.menu}>
        {/* Attach files — hidden when no native picker is available
            on Linux (no xdg-desktop-portal). Drag-and-drop into the
            composer still works, so attachments aren't lost entirely;
            we just can't safely call the dialog plugin. */}
        {browseAvailable && (
          <button
            className={styles.menuItem}
            onClick={onAttachFiles}
            disabled={isRemote}
            title={
              isRemote
                ? t("attachments_not_supported")
                : undefined
            }
          >
            <span className={styles.menuIcon}>
              <Paperclip size={14} />
            </span>
            {t("add_files")}
          </button>
        )}
        {!browseAvailable && (
          <div className={styles.menuItem} title={tCommon("file_picker_unavailable")} style={{ opacity: 0.7, cursor: "default" }}>
            <span className={styles.menuIcon}>
              <Paperclip size={14} />
            </span>
            {tCommon("file_picker_unavailable")}
          </div>
        )}

        {/* Connectors — servers grouped by source with toggle switches */}
        {hasServers && (
          <>
            {(() => {
              const groups = new Map<string, typeof servers>();
              for (const s of servers) {
                const list = groups.get(s.source) ?? [];
                list.push(s);
                groups.set(s.source, list);
              }
              return [...groups.entries()].map(([source, list]) => (
                <div key={source}>
                  <div className={styles.divider} />
                  <div className={styles.groupLabel}>
                    {MCP_SOURCE_LABELS[source as McpSource] ?? source}
                  </div>
                  {list.map((server) => {
                    const status = mcpStatus?.servers.find(
                      (s) => s.name === server.name,
                    );
                    const stateColor = dotColor(status?.state);
                    const isFailed = status?.state === "failed";

                    return (
                      <div key={server.id} className={styles.serverRow}>
                        {isFailed ? (
                          <button
                            type="button"
                            className={styles.serverInfo}
                            onClick={() => handleReconnect(server.name)}
                            title={t("mcp_reconnect_aria", { error: status?.last_error ?? t("mcp_unknown_error") })}
                          >
                            <span
                              className={styles.serverDot}
                              style={{ background: stateColor }}
                            />
                            <span
                              className={`${styles.serverName} ${!server.enabled ? styles.serverNameDisabled : ""}`}
                            >
                              {server.name}
                            </span>
                            <span className={styles.reconnectHint}>{t("mcp_retry")}</span>
                          </button>
                        ) : (
                          <div className={styles.serverInfo}>
                            <span
                              className={styles.serverDot}
                              style={{ background: stateColor }}
                            />
                            <span
                              className={`${styles.serverName} ${!server.enabled ? styles.serverNameDisabled : ""}`}
                            >
                              {server.name}
                            </span>
                          </div>
                        )}
                        <button
                          className={`${styles.toggle} ${server.enabled ? styles.toggleOn : ""}`}
                          onClick={() => handleToggle(server, !server.enabled)}
                          aria-label={server.enabled ? t("mcp_disable_aria", { name: server.name }) : t("mcp_enable_aria", { name: server.name })}
                          role="switch"
                          aria-checked={server.enabled}
                        >
                          <span className={styles.toggleKnob} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ));
            })()}
          </>
        )}

        {/* Manage connectors — opens repo settings */}
        {repoId && (
          <>
            <div className={styles.divider} />
            <button className={styles.manageItem} onClick={handleManage}>
              <span className={styles.menuIcon}>
                <Settings size={14} />
              </span>
              {t("manage_connectors")}
            </button>
          </>
        )}
      </div>
    </>
  );
}
