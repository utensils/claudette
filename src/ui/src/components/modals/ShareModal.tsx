import { useAppStore } from "../../stores/useAppStore";
import { stopLocalServer } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function ShareModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const connectionString = useAppStore((s) => s.localServerConnectionString);
  const setRunning = useAppStore((s) => s.setLocalServerRunning);
  const setConnectionString = useAppStore((s) => s.setLocalServerConnectionString);

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

  const handleCopy = () => {
    if (connectionString) {
      navigator.clipboard.writeText(connectionString);
    }
  };

  return (
    <Modal title="Share This Machine" onClose={closeModal}>
      <div className={shared.field}>
        <label className={shared.label}>Connection string</label>
        <div className={shared.inputRow}>
          <input
            className={shared.input}
            value={connectionString ?? ""}
            readOnly
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <button className={shared.btn} onClick={handleCopy}>
            Copy
          </button>
        </div>
        <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: 4 }}>
          Share this string with others so they can connect to your workspaces from their Claudette app.
        </div>
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={handleStop}>
          Stop sharing
        </button>
        <button className={shared.btnPrimary} onClick={closeModal}>
          Done
        </button>
      </div>
    </Modal>
  );
}
