import { useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { addRemoteConnection } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function AddRemoteModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const addRemote = useAppStore((s) => s.addRemoteConnection);
  const addActiveId = useAppStore((s) => s.addActiveRemoteId);
  const [connectionString, setConnectionString] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!connectionString.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await addRemoteConnection(connectionString.trim());
      addRemote(result.connection);
      addActiveId(result.connection.id);
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Add Remote Server" onClose={closeModal}>
      <div className={shared.field}>
        <label className={shared.label}>Connection string</label>
        <input
          className={shared.input}
          value={connectionString}
          onChange={(e) => setConnectionString(e.target.value)}
          placeholder="claudette://hostname:7683/pairing-token"
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          autoFocus
        />
        <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: 4 }}>
          Paste the connection string shown by claudette-server on the remote machine.
        </div>
        {error && <div className={shared.error}>{error}</div>}
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          Cancel
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleSubmit}
          disabled={loading || !connectionString.trim()}
        >
          {loading ? "Connecting..." : "Connect"}
        </button>
      </div>
    </Modal>
  );
}
