import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import {
  detectMcpServers,
  loadRepositoryMcps,
  saveRepositoryMcps,
} from "../../services/mcp";
import type { McpServer } from "../../types/mcp";
import { Modal } from "./Modal";
import shared from "./shared.module.css";
import styles from "./McpSelectionModal.module.css";

const SOURCE_LABELS: Record<string, string> = {
  user_project_config: "~/.claude.json",
  repo_local_config: ".claude.json",
};

function getTransportType(config: Record<string, unknown>): string {
  if (config.url) {
    const url = String(config.url);
    if (url.includes("/sse") || config.type === "sse") return "sse";
    return "http";
  }
  if (config.command) return "stdio";
  if (config.type) return String(config.type);
  return "unknown";
}

function getConfigSummary(config: Record<string, unknown>): string {
  if (config.command) {
    const args = Array.isArray(config.args) ? config.args.join(" ") : "";
    return `${config.command} ${args}`.trim();
  }
  if (config.url) return String(config.url);
  return "";
}

export function McpSelectionModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const repoId = modalData.repoId as string;

  const [servers, setServers] = useState<McpServer[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prefetchedMcps = modalData.detectedMcps as McpServer[] | undefined;

  useEffect(() => {
    if (!repoId) return;
    setLoading(true);

    const detectPromise = prefetchedMcps
      ? Promise.resolve(prefetchedMcps)
      : detectMcpServers(repoId);
    Promise.all([detectPromise, loadRepositoryMcps(repoId)])
      .then(([detected, saved]) => {
        const savedNames = new Set(saved.map((s) => s.name));

        const merged = new Map<string, McpServer>();
        for (const s of detected) {
          merged.set(s.name, s);
        }
        for (const s of saved) {
          if (!merged.has(s.name)) {
            let config: Record<string, unknown> = {};
            try {
              config = JSON.parse(s.config_json);
            } catch {
              /* ignore */
            }
            merged.set(s.name, {
              name: s.name,
              config,
              source: s.source as McpServer["source"],
            });
          }
        }

        const all = Array.from(merged.values());
        setServers(all);
        setSelected(new Set(all.map((s) => s.name)));

        if (all.length === 0 && savedNames.size === 0) {
          closeModal();
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [repoId, closeModal]);

  const toggleServer = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const selectedServers = servers.filter((s) => selected.has(s.name));
      await saveRepositoryMcps(repoId, selectedServers);
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Modal title={t("mcp_servers_title")} onClose={closeModal}>
        <div className={styles.loading}>{t("mcp_servers_detecting")}</div>
      </Modal>
    );
  }

  if (servers.length === 0) {
    return (
      <Modal title={t("mcp_servers_title")} onClose={closeModal}>
        <p className={styles.description}>
          {t("mcp_servers_none_found")}
        </p>
        <div className={shared.actions}>
          <button className={shared.btn} onClick={closeModal}>
            {tCommon("close")}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t("mcp_servers_detected_title")} onClose={closeModal}>
      <p className={styles.description}>
        {t("mcp_servers_detected_desc")}
      </p>

      <div className={styles.serverList}>
        {servers.map((server) => (
          <label key={server.name} className={styles.serverRow}>
            <input
              type="checkbox"
              checked={selected.has(server.name)}
              onChange={() => toggleServer(server.name)}
            />
            <div className={styles.serverInfo}>
              <div className={styles.serverHeader}>
                <span className={styles.serverName}>{server.name}</span>
                <span className={styles.badge}>
                  {getTransportType(server.config)}
                </span>
                <span className={styles.source}>
                  {SOURCE_LABELS[server.source] ?? server.source}
                </span>
              </div>
              <div className={styles.serverDetail}>
                {getConfigSummary(server.config)}
              </div>
            </div>
          </label>
        ))}
      </div>

      {error && <div className={shared.error}>{error}</div>}

      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          {tCommon("skip")}
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? t("mcp_servers_saving") : t("mcp_servers_confirm")}
        </button>
      </div>
    </Modal>
  );
}
