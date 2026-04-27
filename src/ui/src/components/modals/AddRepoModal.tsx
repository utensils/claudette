import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../stores/useAppStore";
import { addRepository, getDefaultBranch, discoverWorktrees } from "../../services/tauri";
import { detectMcpServers } from "../../services/mcp";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function AddRepoModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const openModal = useAppStore((s) => s.openModal);
  const addRepo = useAppStore((s) => s.addRepository);
  const setDefaultBranches = useAppStore((s) => s.setDefaultBranches);
  const defaultBranches = useAppStore((s) => s.defaultBranches);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        setPath(selected);
        setError(null);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleSubmit = async () => {
    if (!path.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const repo = await addRepository(path.trim());
      addRepo(repo);
      getDefaultBranch(repo.id).then((branch) => {
        if (branch) {
          setDefaultBranches({ ...defaultBranches, [repo.id]: branch });
        }
      });
      let mcps: Awaited<ReturnType<typeof detectMcpServers>> = [];
      try {
        mcps = await detectMcpServers(repo.id);
      } catch {
        // MCP detection is best-effort.
      }

      try {
        const worktrees = await discoverWorktrees(repo.id);
        if (worktrees.length > 0) {
          openModal("importWorktrees", {
            repoId: repo.id,
            pendingMcps: mcps.length > 0 ? mcps : undefined,
          });
          return;
        }
      } catch {
        // Worktree discovery is best-effort.
      }

      if (mcps.length > 0) {
        openModal("mcpSelection", { repoId: repo.id, detectedMcps: mcps });
        return;
      }
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title={t("add_repo_title")} onClose={closeModal}>
      <div className={shared.field}>
        <label className={shared.label}>{t("add_repo_path_label")}</label>
        <div className={shared.inputRow}>
          <input
            className={shared.input}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t("add_repo_path_placeholder")}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            autoFocus
          />
          <button className={shared.btn} onClick={handleBrowse}>
            {tCommon("browse")}
          </button>
        </div>
        {error && <div className={shared.error}>{error}</div>}
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          {tCommon("cancel")}
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleSubmit}
          disabled={loading || !path.trim()}
        >
          {loading ? t("add_repo_adding") : t("add_repo_confirm")}
        </button>
      </div>
    </Modal>
  );
}
