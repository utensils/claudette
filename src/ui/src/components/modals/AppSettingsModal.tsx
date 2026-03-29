import { useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { setAppSetting } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function AppSettingsModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const worktreeBaseDir = useAppStore((s) => s.worktreeBaseDir);
  const setWorktreeBaseDir = useAppStore((s) => s.setWorktreeBaseDir);

  const [path, setPath] = useState(worktreeBaseDir);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    if (!path.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await setAppSetting("worktree_base_dir", path.trim());
      setWorktreeBaseDir(path.trim());
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Settings" onClose={closeModal}>
      <div className={shared.field}>
        <label className={shared.label}>Worktree Base Directory</label>
        <input
          className={shared.input}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/.claudette/workspaces"
          autoFocus
        />
        <div className={shared.hint}>
          Default: ~/.claudette/workspaces
        </div>
        {error && <div className={shared.error}>{error}</div>}
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          Cancel
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleSave}
          disabled={loading || !path.trim()}
        >
          {loading ? "Saving..." : "Save"}
        </button>
      </div>
    </Modal>
  );
}
