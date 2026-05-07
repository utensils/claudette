import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { archiveWorkspace, setArchiveScriptAutoRun } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function ConfirmArchiveScriptModal() {
  const { t } = useTranslation("modals");
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const updateRepository = useAppStore((s) => s.updateRepository);
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const [loading, setLoading] = useState(false);
  const [alwaysRun, setAlwaysRun] = useState(false);

  const workspaceId = modalData.workspaceId as string;
  const script = modalData.script as string;
  const source = modalData.source as string;
  const repoId = modalData.repoId as string;

  const performArchive = async (skipScript: boolean) => {
    setLoading(true);

    const initialState = useAppStore.getState();
    const snapshot = initialState.workspaces.find((w) => w.id === workspaceId);
    const wasSelected = initialState.selectedWorkspaceId === workspaceId;

    updateWorkspace(workspaceId, {
      status: "Archived",
      worktree_path: null,
      agent_status: "Stopped",
    });
    if (wasSelected) selectWorkspace(null);

    try {
      if (!skipScript && alwaysRun && repoId) {
        await setArchiveScriptAutoRun(repoId, true);
        updateRepository(repoId, { archive_script_auto_run: true });
      }
      const deleted = await archiveWorkspace(workspaceId, skipScript);
      if (deleted) {
        removeWorkspace(workspaceId);
      }
      closeModal();
    } catch (e) {
      console.error("Failed to archive workspace:", e);
      if (snapshot) {
        updateWorkspace(workspaceId, snapshot);
        if (wasSelected && useAppStore.getState().selectedWorkspaceId === null) {
          selectWorkspace(workspaceId);
        }
      }
      closeModal();
    }
  };

  const label = source === "repo" ? ".claudette.json" : t("setup_script_source_repo_settings");

  return (
    <Modal title={t("archive_script_title")} onClose={closeModal}>
      <div className={shared.warning}>
        <Trans
          i18nKey="archive_script_warning"
          ns="modals"
          values={{ source: label }}
          components={{ strong: <strong /> }}
        />
      </div>
      <div className={shared.field}>
        <label className={shared.label}>{t("archive_script_label")}</label>
        <pre className={shared.scriptPreview}>{script}</pre>
      </div>
      <div className={shared.field}>
        <label className={shared.checkboxRow}>
          <input
            type="checkbox"
            checked={alwaysRun}
            onChange={(e) => setAlwaysRun(e.target.checked)}
          />
          {t("archive_script_always_run")}
        </label>
      </div>
      <div className={shared.actions}>
        <button
          className={shared.btn}
          onClick={() => performArchive(true)}
          disabled={loading}
        >
          {t("archive_script_skip")}
        </button>
        <button
          className={shared.btnPrimary}
          onClick={() => performArchive(false)}
          disabled={loading}
        >
          {loading ? t("archive_script_running") : t("archive_script_confirm")}
        </button>
      </div>
    </Modal>
  );
}
