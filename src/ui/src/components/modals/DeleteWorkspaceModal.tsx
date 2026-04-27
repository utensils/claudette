import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { deleteWorkspace } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function DeleteWorkspaceModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const [loading, setLoading] = useState(false);

  const wsId = modalData.wsId as string;
  const wsName = modalData.wsName as string;

  const handleDelete = async () => {
    setLoading(true);
    try {
      await deleteWorkspace(wsId);
    } catch (e) {
      console.error("delete_workspace failed, proceeding with local removal:", e);
    }
    removeWorkspace(wsId);
    closeModal();
  };

  return (
    <Modal title={t("delete_workspace_title")} onClose={closeModal}>
      <div className={shared.warning}>
        {t("delete_workspace_warning_pre")} <strong>{wsName}</strong>{t("delete_workspace_warning_post")}
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          {tCommon("cancel")}
        </button>
        <button
          className={shared.btnDanger}
          onClick={handleDelete}
          disabled={loading}
        >
          {loading ? t("delete_workspace_deleting") : t("delete_workspace_confirm")}
        </button>
      </div>
    </Modal>
  );
}
