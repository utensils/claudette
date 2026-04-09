import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { setAppSetting } from "../../services/tauri";
import { applyTheme, loadAllThemes, findTheme } from "../../utils/theme";
import type { ThemeDefinition } from "../../types/theme";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function AppSettingsModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const worktreeBaseDir = useAppStore((s) => s.worktreeBaseDir);
  const setWorktreeBaseDir = useAppStore((s) => s.setWorktreeBaseDir);
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useAppStore((s) => s.setTerminalFontSize);
  const terminalFontFamily = useAppStore((s) => s.terminalFontFamily);
  const setTerminalFontFamily = useAppStore((s) => s.setTerminalFontFamily);
  const currentThemeId = useAppStore((s) => s.currentThemeId);
  const setCurrentThemeId = useAppStore((s) => s.setCurrentThemeId);

  const [path, setPath] = useState(worktreeBaseDir);
  const [fontSize, setFontSize] = useState(String(terminalFontSize));
  const [fontFamily, setFontFamily] = useState(terminalFontFamily);
  const [selectedThemeId, setSelectedThemeId] = useState(currentThemeId);
  const [availableThemes, setAvailableThemes] = useState<ThemeDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const originalThemeIdRef = useRef(currentThemeId);

  useEffect(() => {
    loadAllThemes().then(setAvailableThemes);
  }, []);

  const handleThemeChange = (id: string) => {
    setSelectedThemeId(id);
    const theme = findTheme(availableThemes, id);
    applyTheme(theme);
  };

  const handleCancel = () => {
    if (selectedThemeId !== originalThemeIdRef.current) {
      const theme = findTheme(availableThemes, originalThemeIdRef.current);
      applyTheme(theme);
    }
    closeModal();
  };

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

      await setAppSetting("terminal_font_family", fontFamily.trim());
      setTerminalFontFamily(fontFamily.trim());

      await setAppSetting("theme", selectedThemeId);
      setCurrentThemeId(selectedThemeId);

      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Settings" onClose={handleCancel}>
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
          <label className={shared.label}>Color Theme</label>
          <select
            className={shared.input}
            value={selectedThemeId}
            onChange={(e) => handleThemeChange(e.target.value)}
          >
            {availableThemes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <div className={shared.hint}>
            Add custom themes to ~/.claudette/themes/
          </div>
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
        <div className={shared.field}>
          <label className={shared.label}>Terminal Font Family</label>
          <input
            className={shared.input}
            type="text"
            value={fontFamily}
            onChange={(e) => setFontFamily(e.target.value)}
            placeholder="monospace"
          />
          <div className={shared.hint}>
            Font name (e.g., "FiraCode Nerfont", "Monaco", "Consolas")
          </div>
        </div>
      </div>

      {error && <div className={shared.error}>{error}</div>}
      <div className={shared.actions}>
        <button className={shared.btn} onClick={handleCancel}>
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
