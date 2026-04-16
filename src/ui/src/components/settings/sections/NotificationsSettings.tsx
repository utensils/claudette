import { useEffect, useState } from "react";
import {
  getAppSetting,
  setAppSetting,
  listNotificationSounds,
  playNotificationSound,
  runNotificationCommand,
} from "../../../services/tauri";
import styles from "../Settings.module.css";

export function NotificationsSettings() {
  const [notificationSound, setNotificationSound] = useState("Default");
  const [availableSounds, setAvailableSounds] = useState<string[]>([
    "Default",
    "None",
  ]);
  const [notificationCommand, setNotificationCommand] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listNotificationSounds().then(setAvailableSounds).catch(() => {});
    getAppSetting("notification_sound")
      .then(async (val) => {
        if (val) {
          setNotificationSound(val);
        } else {
          const legacy = await getAppSetting("audio_notifications");
          if (legacy === "false") setNotificationSound("None");
          else setNotificationSound("Default");
        }
      })
      .catch(() => {});
    getAppSetting("notification_command")
      .then((val) => {
        if (val) setNotificationCommand(val);
      })
      .catch(() => {});
  }, []);

  const handleSoundChange = async (sound: string) => {
    const prev = notificationSound;
    setNotificationSound(sound);
    try {
      setError(null);
      await setAppSetting("notification_sound", sound);
    } catch (e) {
      setNotificationSound(prev);
      setError(String(e));
    }
  };

  const handleCommandBlur = async () => {
    try {
      setError(null);
      await setAppSetting("notification_command", notificationCommand);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleTestCommand = async () => {
    try {
      setError(null);
      await setAppSetting("notification_command", notificationCommand);
      await runNotificationCommand(
        "test-workspace",
        "test",
        "",
        "",
        "main",
        "claudette/test-workspace"
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Command failed");
    }
  };

  return (
    <div>
      <h2 className={styles.sectionTitle}>Notifications</h2>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Notification sound</div>
          <div className={styles.settingDescription}>
            Sound played when an agent needs input or finishes in the background
          </div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.inlineControl}>
            <select
              className={styles.select}
              value={notificationSound}
              onChange={(e) => handleSoundChange(e.target.value)}
            >
              {availableSounds.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              className={styles.iconBtn}
              onClick={() => playNotificationSound(notificationSound)}
              title="Preview sound"
              aria-label="Preview sound"
            >
              &#9654;
            </button>
          </div>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Notification command</div>
          <div className={styles.settingDescription}>
            Run a shell command when a notification arrives. Workspace
            environment variables ($CLAUDETTE_WORKSPACE_NAME,
            $CLAUDETTE_WORKSPACE_PATH, etc.) are set.
          </div>
          {error && <div className={styles.error}>{error}</div>}
        </div>
        <div className={styles.settingControl}>
          <div className={styles.inlineControl}>
            <input
              className={styles.input}
              value={notificationCommand}
              onChange={(e) => setNotificationCommand(e.target.value)}
              onBlur={handleCommandBlur}
              placeholder={'e.g. say "done"'}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button
              className={styles.iconBtn}
              disabled={!notificationCommand.trim()}
              onClick={handleTestCommand}
              title="Test command"
              aria-label="Test command"
            >
              &#9654;
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
