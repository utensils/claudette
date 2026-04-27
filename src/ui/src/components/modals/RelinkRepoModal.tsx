import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { relinkRepository } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function RelinkRepoModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const updateRepo = useAppStore((s) => s.updateRepository);

  const repoId = modalData.repoId as string;
  const repoName = modalData.repoName as string;

  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleRelink = async () => {
    if (!path.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await relinkRepository(repoId, path.trim());
      updateRepo(repoId, { path: path.trim(), path_valid: true });
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title={t("relink_title")} onClose={closeModal}>
      <div className={shared.warning}>
        {t("relink_warning_pre")} <strong>{repoName}</strong> {t("relink_warning_post")}
      </div>
      <div className={shared.field}>
        <label className={shared.label}>{t("relink_new_path_label")}</label>
        <input
          className={shared.input}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={t("relink_new_path_placeholder")}
          onKeyDown={(e) => e.key === "Enter" && handleRelink()}
          autoFocus
        />
        {error && <div className={shared.error}>{error}</div>}
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          {tCommon("cancel")}
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleRelink}
          disabled={loading || !path.trim()}
        >
          {loading ? t("relink_relinking") : t("relink_confirm")}
        </button>
      </div>
    </Modal>
  );
}
