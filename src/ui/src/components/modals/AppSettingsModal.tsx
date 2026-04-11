import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { getAppSetting, setAppSetting, listNotificationSounds, playNotificationSound, runNotificationCommand } from "../../services/tauri";
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
  const currentThemeId = useAppStore((s) => s.currentThemeId);
  const setCurrentThemeId = useAppStore((s) => s.setCurrentThemeId);
  const [path, setPath] = useState(worktreeBaseDir);
  const [fontSize, setFontSize] = useState(String(terminalFontSize));
  const [selectedThemeId, setSelectedThemeId] = useState(currentThemeId);
  const [availableThemes, setAvailableThemes] = useState<ThemeDefinition[]>([]);
  const [trayEnabled, setTrayEnabled] = useState(true);
  const [notificationSound, setNotificationSound] = useState("Default");
  const [availableSounds, setAvailableSounds] = useState<string[]>(["Default", "None"]);
  const [notificationCommand, setNotificationCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const originalThemeIdRef = useRef(currentThemeId);

  useEffect(() => {
    loadAllThemes().then(setAvailableThemes);
    getAppSetting("tray_enabled").then((val) => {
      setTrayEnabled(val !== "false");
    });
    listNotificationSounds().then(setAvailableSounds);
    getAppSetting("notification_sound").then(async (val) => {
      if (val) {
        setNotificationSound(val);
      } else {
        // Default to "Default" for fresh installs.
        // Only set "None" if legacy audio_notifications was explicitly disabled.
        const legacy = await getAppSetting("audio_notifications");
        if (legacy === "false") setNotificationSound("None");
        else setNotificationSound("Default");
      }
    });
    getAppSetting("notification_command").then((val) => {
      if (val) setNotificationCommand(val);
    });
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

      await setAppSetting("theme", selectedThemeId);
      setCurrentThemeId(selectedThemeId);

      await setAppSetting("notification_sound", notificationSound);
      await setAppSetting("notification_command", notificationCommand);

      await setAppSetting("tray_enabled", trayEnabled ? "true" : "false");

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
          Notifications
        </div>
        <div className={shared.field}>
          <label className={shared.label}>Notification Sound</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
              className={shared.input}
              style={{ flex: 1 }}
              value={notificationSound}
              onChange={(e) => setNotificationSound(e.target.value)}
            >
              {availableSounds.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <button
              className={shared.btn}
              style={{ whiteSpace: "nowrap" }}
              onClick={() => playNotificationSound(notificationSound)}
              title="Preview sound"
            >
              &#9654;
            </button>
          </div>
          <div className={shared.hint}>
            Sound played when an agent needs input or finishes in the background.
          </div>
        </div>
        <div className={shared.field} style={{ marginTop: 8 }}>
          <label className={shared.label}>Notification Command</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              className={shared.input}
              style={{ flex: 1 }}
              value={notificationCommand}
              onChange={(e) => setNotificationCommand(e.target.value)}
              placeholder={'e.g. say "done"'}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button
              className={shared.btn}
              style={{ whiteSpace: "nowrap" }}
              disabled={!notificationCommand.trim()}
              onClick={async () => {
                await setAppSetting("notification_command", notificationCommand);
                runNotificationCommand(
                  "Test Notification",
                  "This is a test notification",
                  "test",
                  "test-workspace",
                );
              }}
              title="Test command"
            >
              &#9654;
            </button>
          </div>
          <div className={shared.hint}>
            Run a shell command when a notification arrives.
            $CLAUDETTE_NOTIFICATION_TITLE, $CLAUDETTE_NOTIFICATION_BODY,
            $CLAUDETTE_WORKSPACE_NAME are set.
          </div>
        </div>
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
          System Tray
        </div>
        <div className={shared.field}>
          <label
            className={shared.label}
            style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={trayEnabled}
              onChange={(e) => setTrayEnabled(e.target.checked)}
            />
            Show in system tray / menu bar
          </label>
          <div className={shared.hint}>
            Shows running agent status and allows quick workspace switching.
            Closing the window will minimize to tray when enabled.
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
