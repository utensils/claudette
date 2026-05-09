import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../stores/useAppStore";
import { addRepository, initRepository, getDefaultBranch, discoverWorktrees } from "../../services/tauri";
import { detectMcpServers } from "../../services/mcp";
import { Modal } from "./Modal";
import shared from "./shared.module.css";
import styles from "./AddRepoModal.module.css";

type Mode = "open" | "create";

export function AddRepoModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const openModal = useAppStore((s) => s.openModal);
  const addRepo = useAppStore((s) => s.addRepository);
  const setDefaultBranches = useAppStore((s) => s.setDefaultBranches);
  const defaultBranches = useAppStore((s) => s.defaultBranches);

  const [mode, setMode] = useState<Mode>("open");
  const [path, setPath] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleBrowseExisting = async () => {
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

  const handleBrowseParent = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        setParentPath(selected);
        setError(null);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleOpenExisting = async () => {
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

  const handleCreateNew = async () => {
    if (!parentPath.trim() || !projectName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const repo = await initRepository(parentPath.trim(), projectName.trim());
      addRepo(repo);
      setDefaultBranches({ ...defaultBranches, [repo.id]: "main" });
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = mode === "open" ? handleOpenExisting : handleCreateNew;
  const submitDisabled =
    loading || (mode === "open" ? !path.trim() : !parentPath.trim() || !projectName.trim());

  return (
    <Modal title={t("add_repo_title")} onClose={closeModal}>
      <div className={styles.tabs}>
        <button
          className={mode === "open" ? styles.tabActive : styles.tab}
          onClick={() => { setMode("open"); setError(null); }}
        >
          {t("add_repo_tab_open")}
        </button>
        <button
          className={mode === "create" ? styles.tabActive : styles.tab}
          onClick={() => { setMode("create"); setError(null); }}
        >
          {t("add_repo_tab_create")}
        </button>
      </div>

      {mode === "open" ? (
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
            <button className={shared.btn} onClick={handleBrowseExisting}>
              {tCommon("browse")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={shared.field}>
            <label className={shared.label}>{t("add_repo_create_location_label")}</label>
            <div className={shared.inputRow}>
              <input
                className={shared.input}
                value={parentPath}
                onChange={(e) => setParentPath(e.target.value)}
                placeholder={t("add_repo_create_location_placeholder")}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              />
              <button className={shared.btn} onClick={handleBrowseParent}>
                {tCommon("browse")}
              </button>
            </div>
          </div>
          <div className={shared.field}>
            <label className={shared.label}>{t("add_repo_create_name_label")}</label>
            <input
              className={shared.input}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder={t("add_repo_create_name_placeholder")}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              autoFocus
            />
          </div>
        </>
      )}

      {error && <div className={shared.error}>{error}</div>}

      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          {tCommon("cancel")}
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleSubmit}
          disabled={submitDisabled}
        >
          {loading
            ? mode === "open" ? t("add_repo_adding") : t("add_repo_creating")
            : mode === "open" ? t("add_repo_confirm") : t("add_repo_create_confirm")}
        </button>
      </div>
    </Modal>
  );
}
