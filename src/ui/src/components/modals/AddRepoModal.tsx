import { useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { addRepository } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function AddRepoModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const addRepo = useAppStore((s) => s.addRepository);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!path.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const repo = await addRepository(path.trim());
      addRepo(repo);
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Add Repository" onClose={closeModal}>
      <div className={shared.field}>
        <label className={shared.label}>Repository path</label>
        <input
          className={shared.input}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/path/to/repository"
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
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
          onClick={handleSubmit}
          disabled={loading || !path.trim()}
        >
          {loading ? "Adding..." : "Add"}
        </button>
      </div>
    </Modal>
  );
}
