import { useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { setAppSetting } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function AppSettingsModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const worktreeBaseDir = useAppStore((s) => s.worktreeBaseDir);
  const setWorktreeBaseDir = useAppStore((s) => s.setWorktreeBaseDir);
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useAppStore((s) => s.setTerminalFontSize);

  const [path, setPath] = useState(worktreeBaseDir);
  const [fontSize, setFontSize] = useState(String(terminalFontSize));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    if (!path.trim()) return;

    const size = parseInt(fontSize, 10);
    if (isNaN(size) || size < 8 || size > 24) {
      setError("Terminal font size must be between 8 and 24");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await setAppSetting("worktree_base_dir", path.trim());
      setWorktreeBaseDir(path.trim());

      await setAppSetting("terminal_font_size", String(size));
      setTerminalFontSize(size);

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
        <div className={shared.hint}>Default: ~/.claudette/workspaces</div>
      </div>

      <div
        style={{
          borderTop: "1px solid var(--divider)",
          marginTop: 16,
          paddingTop: 12,
        }}
      >
        <div
          className={shared.label}
          style={{ marginBottom: 8, fontWeight: 600 }}
        >
          Appearance
        </div>
        <div className={shared.field}>
          <label className={shared.label}>Terminal Font Size</label>
          <input
            className={shared.input}
            type="number"
            min={8}
            max={24}
            value={fontSize}
            onChange={(e) => setFontSize(e.target.value)}
            style={{ width: 80 }}
          />
          <div className={shared.hint}>8–24px (default: 11)</div>
        </div>
      </div>

      {error && <div className={shared.error}>{error}</div>}
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
