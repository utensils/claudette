import { useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { applyUpdateChannel } from "../../hooks/useAutoUpdater";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function ConfirmNightlyChannelModal() {
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

  return (
    <Modal title="Switch to Nightly Channel?" onClose={closeModal}>
      <div className={shared.warning}>
        Nightly builds are untested pre-releases built from the latest{" "}
        <strong>main</strong> branch. They may contain bugs or break features.
        You can switch back to Stable at any time.
      </div>
      {error && <div className={shared.error}>{error}</div>}
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal} disabled={loading}>
          Cancel
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleConfirm}
          disabled={loading}
        >
          {loading ? "Switching..." : "Switch to Nightly"}
        </button>
      </div>
    </Modal>
  );
}
