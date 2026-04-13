import { useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { deleteWorkspace } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function DeleteWorkspaceModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsId = modalData.wsId as string;
  const wsName = modalData.wsName as string;

  const handleDelete = async () => {
    setLoading(true);
    try {
      await deleteWorkspace(wsId);
      removeWorkspace(wsId);
      closeModal();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  return (
    <Modal title="Delete Workspace" onClose={closeModal}>
      <div className={shared.warning}>
        Are you sure you want to delete <strong>{wsName}</strong>? The branch
        and any unmerged commits will be permanently deleted.
      </div>
      {error && <div className={shared.error}>{error}</div>}
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          Cancel
        </button>
        <button
          className={shared.btnDanger}
          onClick={handleDelete}
          disabled={loading}
        >
          {loading ? "Deleting..." : "Delete"}
        </button>
      </div>
    </Modal>
  );
}
