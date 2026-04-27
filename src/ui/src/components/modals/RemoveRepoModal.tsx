import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { removeRepository } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function RemoveRepoModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const removeRepo = useAppStore((s) => s.removeRepository);
  const workspaces = useAppStore((s) => s.workspaces);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repoId = modalData.repoId as string;
  const repoName = modalData.repoName as string;

  const affected = workspaces.filter((w) => w.repository_id === repoId);
  const active = affected.filter((w) => w.status === "Active").length;
  const archived = affected.filter((w) => w.status === "Archived").length;

  const handleRemove = async () => {
    setLoading(true);
    try {
      await removeRepository(repoId);
      removeRepo(repoId);
      closeModal();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  return (
    <Modal title={t("remove_repo_title")} onClose={closeModal}>
      <div className={shared.warning}>
        {t("remove_repo_warning_pre")} <strong>{repoName}</strong>{t("remove_repo_warning_post")}
      </div>
      {(active > 0 || archived > 0) && (
        <div className={shared.warning}>
          {t("remove_repo_will_destroy_pre")}{" "}
          {active > 0 && t("remove_repo_active", { count: active })}
          {active > 0 && archived > 0 && ", "}
          {archived > 0 && t("remove_repo_archived", { count: archived })}{" "}
          {t(active + archived > 1 ? "remove_repo_workspaces" : "remove_repo_workspace")}.
        </div>
      )}
      {error && <div className={shared.error}>{error}</div>}
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          {tCommon("cancel")}
        </button>
        <button
          className={shared.btnDanger}
          onClick={handleRemove}
          disabled={loading}
        >
          {loading ? t("remove_repo_removing") : t("remove_repo_confirm")}
        </button>
      </div>
    </Modal>
  );
}
