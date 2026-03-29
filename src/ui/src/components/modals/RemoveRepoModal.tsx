import { useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { removeRepository } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function RemoveRepoModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const removeRepo = useAppStore((s) => s.removeRepository);
  const workspaces = useAppStore((s) => s.workspaces);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repoId = modalData.repoId as string;
  const repoName = modalData.repoName as string;

  const affected = workspaces.filter((w) => w.repository_id === repoId);
  const active = affected.filter((w) => w.status === "Active").length;
  const archived = affected.filter((w) => w.status === "Archived").length;

  const handleRemove = async () => {
    setLoading(true);
    try {
      await removeRepository(repoId);
      removeRepo(repoId);
      closeModal();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  return (
    <Modal title="Remove Repository" onClose={closeModal}>
      <div className={shared.warning}>
        Are you sure you want to remove <strong>{repoName}</strong>? This will
        not delete the repository from disk, only unregister it.
      </div>
      {(active > 0 || archived > 0) && (
        <div className={shared.warning}>
          Will permanently destroy: {active > 0 && `${active} active`}
          {active > 0 && archived > 0 && ", "}
          {archived > 0 && `${archived} archived`} workspace
          {active + archived > 1 ? "s" : ""}.
        </div>
      )}
      {error && <div className={shared.error}>{error}</div>}
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          Cancel
        </button>
        <button
          className={shared.btnDanger}
          onClick={handleRemove}
          disabled={loading}
        >
          {loading ? "Removing..." : "Remove"}
        </button>
      </div>
    </Modal>
  );
}
