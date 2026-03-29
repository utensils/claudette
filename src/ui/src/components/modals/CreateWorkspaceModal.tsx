import { useState, useEffect } from "react";
import { useAppStore } from "../../stores/useAppStore";
import {
  createWorkspace,
  generateWorkspaceName,
} from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function CreateWorkspaceModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const repoId = modalData.repoId as string;
  const repoName = modalData.repoName as string;

  useEffect(() => {
    generateWorkspaceName().then(setName);
  }, []);

  const regenerate = () => {
    generateWorkspaceName().then(setName);
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const ws = await createWorkspace(repoId, name.trim());
      addWorkspace(ws);
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="New Workspace" onClose={closeModal}>
      <div className={shared.hint} style={{ marginBottom: 12 }}>
        Repository: {repoName}
      </div>
      <div className={shared.field}>
        <label className={shared.label}>Workspace name</label>
        <div className={shared.inputRow}>
          <input
            className={shared.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            autoFocus
          />
          <button className={shared.btn} onClick={regenerate} title="Regenerate">
            ↻
          </button>
        </div>
        <div className={shared.hint}>Branch: claudette/{name}</div>
        {error && <div className={shared.error}>{error}</div>}
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          Cancel
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleSubmit}
          disabled={loading || !name.trim()}
        >
          {loading ? "Creating..." : "Create"}
        </button>
      </div>
    </Modal>
  );
}
