import { useEffect, useState } from "react";
import {
  getAppSetting,
  setAppSetting,
  listNotificationSounds,
  playNotificationSound,
  runNotificationCommand,
} from "../../../services/tauri";
import styles from "../Settings.module.css";

interface SoundEvent {
  key: string;
  label: string;
  description: string;
}

const SOUND_EVENTS: SoundEvent[] = [
  {
    key: "notification_sound_ask",
    label: "Agent question",
    description: "Sound when an agent needs your input",
  },
  {
    key: "notification_sound_plan",
    label: "Plan ready",
    description: "Sound when an agent has a plan for review",
  },
  {
    key: "notification_sound_finished",
    label: "Work complete",
    description: "Sound when an agent finishes its task",
  },
];

async function resolveSound(eventKey: string): Promise<string> {
  const perEvent = await getAppSetting(eventKey);
  if (perEvent) return perEvent;
  const global = await getAppSetting("notification_sound");
  if (global) return global;
  const legacy = await getAppSetting("audio_notifications");
  if (legacy === "false") return "None";
  return "Default";
}

export function NotificationsSettings() {
  const [sounds, setSounds] = useState<Record<string, string>>({
    notification_sound_ask: "Default",
    notification_sound_plan: "Default",
    notification_sound_finished: "Default",
  });
  const [availableSounds, setAvailableSounds] = useState<string[]>([
    "Default",
    "None",
  ]);
  const [notificationCommand, setNotificationCommand] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listNotificationSounds().then(setAvailableSounds).catch(() => {});
    for (const event of SOUND_EVENTS) {
      resolveSound(event.key)
        .then((val) =>
          setSounds((prev) => ({ ...prev, [event.key]: val })),
        )
        .catch(() => {});
    }
    getAppSetting("notification_command")
      .then((val) => {
        if (val) setNotificationCommand(val);
      })
      .catch(() => {});
  }, []);

  const handleSoundChange = async (key: string, sound: string) => {
    const prev = sounds[key];
    setSounds((s) => ({ ...s, [key]: sound }));
    try {
      setError(null);
      await setAppSetting(key, sound);
    } catch (e) {
      setSounds((s) => ({ ...s, [key]: prev }));
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
        "claudette/test-workspace",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Command failed");
    }
  };

  return (
    <div>
      <h2 className={styles.sectionTitle}>Notifications</h2>

      {SOUND_EVENTS.map((event) => (
        <div key={event.key} className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <div className={styles.settingLabel}>{event.label}</div>
            <div className={styles.settingDescription}>
              {event.description}
            </div>
          </div>
          <div className={styles.settingControl}>
            <div className={styles.inlineControl}>
              <select
                className={styles.select}
                value={sounds[event.key]}
                onChange={(e) =>
                  handleSoundChange(event.key, e.target.value)
                }
              >
                {availableSounds.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                className={styles.iconBtn}
                onClick={() => playNotificationSound(sounds[event.key])}
                title="Preview sound"
                aria-label={`Preview ${event.label} sound`}
              >
                &#9654;
              </button>
            </div>
          </div>
        </div>
      ))}

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
