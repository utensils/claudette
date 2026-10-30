import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { addRemoteConnection } from "../../services/tauri";
import { adoptPairResult } from "../sidebar/remoteConnectionActions";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function AddRemoteModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const [connectionString, setConnectionString] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!connectionString.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await addRemoteConnection(connectionString.trim());
      adoptPairResult(result);
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title={t("add_remote_title")} onClose={closeModal}>
      <div className={shared.field}>
        <label className={shared.label}>{t("add_remote_conn_label")}</label>
        <input
          className={shared.input}
          value={connectionString}
          onChange={(e) => setConnectionString(e.target.value)}
          placeholder={t("add_remote_conn_placeholder")}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          autoFocus
        />
        <div className={shared.smallHint}>
          {t("add_remote_conn_hint")}
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
          disabled={loading || !connectionString.trim()}
        >
          {loading ? t("add_remote_connecting") : t("add_remote_confirm")}
        </button>
      </div>
    </Modal>
  );
}
