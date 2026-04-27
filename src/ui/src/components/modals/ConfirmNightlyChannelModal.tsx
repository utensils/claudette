import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { applyUpdateChannel } from "../../hooks/useAutoUpdater";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function ConfirmNightlyChannelModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await applyUpdateChannel("nightly");
      closeModal();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (loading) return;
    closeModal();
  };

  return (
    <Modal title={t("nightly_title")} onClose={handleClose}>
      <div className={shared.warning}>
        {t("nightly_warning_pre")}{" "}
        <strong>main</strong>{" "}
        {t("nightly_warning_post")}
      </div>
      {error && <div className={shared.error}>{error}</div>}
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal} disabled={loading}>
          {tCommon("cancel")}
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleConfirm}
          disabled={loading}
        >
          {loading ? t("nightly_switching") : t("nightly_confirm")}
        </button>
      </div>
    </Modal>
  );
}
