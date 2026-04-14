import { useEffect, useState } from "react";
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

/** Infer transport type from the config object for display. */
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

/** Get a one-line summary of the config for display. */
function getConfigSummary(config: Record<string, unknown>): string {
  if (config.command) {
    const args = Array.isArray(config.args) ? config.args.join(" ") : "";
    return `${config.command} ${args}`.trim();
  }
  if (config.url) return String(config.url);
  return "";
}

export function McpSelectionModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const repoId = modalData.repoId as string;

  const [servers, setServers] = useState<McpServer[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoId) return;
    setLoading(true);

    // Load both detected and already-saved servers, then merge.
    // Already-saved servers stay selected; newly detected ones are also
    // pre-selected (opt-out default).
    Promise.all([detectMcpServers(repoId), loadRepositoryMcps(repoId)])
      .then(([detected, saved]) => {
        const savedNames = new Set(saved.map((s) => s.name));

        // Build merged list: start with detected servers, then add any
        // saved servers that were NOT re-detected (source may have changed).
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
        // Pre-select everything: already-saved + newly detected.
        setSelected(new Set(all.map((s) => s.name)));

        // If nothing to show and nothing was saved, close automatically
        // (first-time add-repo with no MCPs).
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
      <Modal title="MCP Servers" onClose={closeModal}>
        <div className={styles.loading}>Detecting MCP servers...</div>
      </Modal>
    );
  }

  if (servers.length === 0) {
    return (
      <Modal title="MCP Servers" onClose={closeModal}>
        <p className={styles.description}>
          No non-portable MCP servers detected for this repository.
        </p>
        <div className={shared.actions}>
          <button className={shared.btn} onClick={closeModal}>
            Close
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="MCP Servers Detected" onClose={closeModal}>
      <p className={styles.description}>
        These MCP servers are configured for this project but won't be
        automatically available in workspaces. Select which to include:
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
          Skip
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save Selections"}
        </button>
      </div>
    </Modal>
  );
}
