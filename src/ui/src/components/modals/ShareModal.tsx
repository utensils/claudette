import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { useAppStore } from "../../stores/useAppStore";
import { stopLocalServer } from "../../services/tauri";
import { Modal } from "./Modal";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import shared from "./shared.module.css";
import styles from "./ShareModal.module.css";

export function ShareModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const connectionString = useAppStore((s) => s.localServerConnectionString);
  const setRunning = useAppStore((s) => s.setLocalServerRunning);
  const setConnectionString = useAppStore((s) => s.setLocalServerConnectionString);
  const { copied, copy } = useCopyToClipboard();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    // Render the connection string as a QR on the canvas. The `qrcode` lib
    // draws black pixels on a white quiet-zone background, so the QR stays
    // scannable against the dark modal surround without theme tokens.
    // Errors are surfaced to the console rather than the UI because the
    // copy-paste path (already shown above the QR) is the fallback.
    if (!canvasRef.current || !connectionString) return;
    QRCode.toCanvas(canvasRef.current, connectionString, {
      width: 220,
      margin: 2,
      errorCorrectionLevel: "M",
    }).catch((err) => {
      console.error("Failed to render pairing QR:", err);
    });
  }, [connectionString]);

  const handleStop = async () => {
    try {
      await stopLocalServer();
      setRunning(false);
      setConnectionString(null);
      closeModal();
    } catch (e) {
      console.error("Failed to stop server:", e);
    }
  };

  return (
    <Modal title={t("share_title")} onClose={closeModal}>
      <div className={shared.field}>
        <label className={shared.label}>{t("share_conn_label")}</label>
        <div className={shared.inputRow}>
          <input
            className={shared.input}
            value={connectionString ?? ""}
            readOnly
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <button
            type="button"
            className={shared.btn}
            onClick={() => void copy(connectionString ?? "")}
            disabled={!connectionString}
          >
            {copied ? tCommon("copied") : tCommon("copy")}
          </button>
        </div>
        <div className={shared.smallHint}>
          {t("share_conn_hint")}
        </div>
      </div>
      {connectionString ? (
        <div className={shared.field}>
          <label className={shared.label}>{t("share_qr_label")}</label>
          <div className={styles.qrFrame}>
            <canvas ref={canvasRef} className={styles.qrCanvas} aria-label={t("share_qr_alt")} />
          </div>
          <div className={shared.smallHint}>{t("share_qr_hint")}</div>
        </div>
      ) : null}
      <div className={shared.actions}>
        <button className={shared.btn} onClick={handleStop}>
          {t("share_stop")}
        </button>
        <button className={shared.btnPrimary} onClick={closeModal}>
          {tCommon("done")}
        </button>
      </div>
    </Modal>
  );
}
