import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { pairRemoteServer } from "../sidebar/remoteConnectionActions";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

/**
 * Pair with a specific server (picked from Nearby, or a saved server whose
 * certificate changed). `modalData`: `host`, `port`, `name`, and optional
 * `fingerprintPrefix` — the prefix advertised over mDNS, which the Rust
 * side checks before sending the token.
 */
export function PairRemoteModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const host = typeof modalData.host === "string" ? modalData.host : "";
  const port = typeof modalData.port === "number" ? modalData.port : 0;
  const name = typeof modalData.name === "string" ? modalData.name : host;
  const fingerprintPrefix =
    typeof modalData.fingerprintPrefix === "string"
      ? modalData.fingerprintPrefix
      : undefined;
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    const trimmed = token.trim();
    if (!trimmed || !host || !port) return;
    setLoading(true);
    setError(null);
    try {
      await pairRemoteServer(host, port, trimmed, fingerprintPrefix);
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title={t("pair_remote_title", { name })} onClose={closeModal}>
      <div className={shared.field}>
        <label className={shared.label}>{t("pair_remote_token_label")}</label>
        <input
          className={shared.input}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        <div className={shared.smallHint}>
          {t("pair_remote_hint", { host: `${host}:${port}` })}
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
          disabled={loading || !token.trim()}
        >
          {loading ? t("add_remote_connecting") : t("pair_remote_confirm")}
        </button>
      </div>
    </Modal>
  );
}
