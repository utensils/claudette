import { useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { relinkRepository } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function RelinkRepoModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const updateRepo = useAppStore((s) => s.updateRepository);

  const repoId = modalData.repoId as string;
  const repoName = modalData.repoName as string;

  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleRelink = async () => {
    if (!path.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await relinkRepository(repoId, path.trim());
      updateRepo(repoId, { path: path.trim(), path_valid: true });
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Re-link Repository" onClose={closeModal}>
      <div className={shared.warning}>
        Path for <strong>{repoName}</strong> is no longer valid. Provide the new
        location.
      </div>
      <div className={shared.field}>
        <label className={shared.label}>New path</label>
        <input
          className={shared.input}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/new/path/to/repository"
          onKeyDown={(e) => e.key === "Enter" && handleRelink()}
          autoFocus
        />
        {error && <div className={shared.error}>{error}</div>}
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          Cancel
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleRelink}
          disabled={loading || !path.trim()}
        >
          {loading ? "Re-linking..." : "Re-link"}
        </button>
      </div>
    </Modal>
  );
}
