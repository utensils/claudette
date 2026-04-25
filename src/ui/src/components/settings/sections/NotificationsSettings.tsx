import { useCallback, useEffect, useState } from "react";
import {
  getAppSetting,
  setAppSetting,
  listNotificationSounds,
  playNotificationSound,
  runNotificationCommand,
  cespListInstalled,
  cespPreviewSound,
} from "../../../services/tauri";
import type { InstalledSoundPack } from "../../../types/soundpacks";
import { SoundPackBrowser } from "./SoundPackBrowser";
import styles from "../Settings.module.css";

interface SoundEvent {
  key: string;
  cespCategory: string;
  label: string;
  description: string;
}

const SOUND_EVENTS: SoundEvent[] = [
  {
    key: "notification_sound_ask",
    cespCategory: "input.required",
    label: "Agent question",
    description: "Sound when an agent needs your input",
  },
  {
    key: "notification_sound_plan",
    cespCategory: "task.acknowledge",
    label: "Plan ready",
    description: "Sound when an agent has a plan for review",
  },
  {
    key: "notification_sound_finished",
    cespCategory: "task.complete",
    label: "Work complete",
    description: "Sound when an agent finishes its task",
  },
  {
    key: "notification_sound_error",
    cespCategory: "task.error",
    label: "Error",
    description: "Sound when an agent encounters an error",
  },
  {
    key: "notification_sound_session_start",
    cespCategory: "session.start",
    label: "Session start",
    description: "Sound when a new session begins",
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
  const [soundSource, setSoundSource] = useState<"system" | "openpeon">(
    "system",
  );
  const [sounds, setSounds] = useState<Record<string, string>>({
    notification_sound_ask: "Default",
    notification_sound_plan: "Default",
    notification_sound_finished: "Default",
    notification_sound_error: "Default",
    notification_sound_session_start: "Default",
  });
  const [availableSounds, setAvailableSounds] = useState<string[]>([
    "Default",
    "None",
  ]);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [activePack, setActivePack] = useState("");
  const [activePackLoaded, setActivePackLoaded] = useState(false);
  const [installed, setInstalled] = useState<InstalledSoundPack[]>([]);
  const [showBrowser, setShowBrowser] = useState(false);
  const [notificationCommand, setNotificationCommand] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadInstalled = useCallback(() => {
    cespListInstalled()
      .then(setInstalled)
      .catch(() => {});
  }, []);

  useEffect(() => {
    getAppSetting("sound_source")
      .then((val) => {
        if (val === "openpeon") setSoundSource("openpeon");
      })
      .catch(() => {});
    listNotificationSounds().then(setAvailableSounds).catch(() => {});
    for (const event of SOUND_EVENTS) {
      resolveSound(event.key)
        .then((val) =>
          setSounds((prev) => ({ ...prev, [event.key]: val })),
        )
        .catch(() => {});
    }
    getAppSetting("cesp_volume")
      .then((val) => {
        if (val) {
          const parsed = parseFloat(val);
          if (Number.isFinite(parsed)) {
            setVolume(Math.round(Math.min(1, Math.max(0, parsed)) * 100));
          }
        }
      })
      .catch(() => {});
    getAppSetting("cesp_muted")
      .then((val) => setMuted(val === "true"))
      .catch(() => {});
    getAppSetting("cesp_active_pack")
      .then((val) => {
        if (val) setActivePack(val);
      })
      .catch(() => {})
      .finally(() => setActivePackLoaded(true));
    loadInstalled();
    getAppSetting("notification_command")
      .then((val) => {
        if (val) setNotificationCommand(val);
      })
      .catch(() => {});
  }, [loadInstalled]);

  useEffect(() => {
    if (!activePackLoaded) return;
    if (installed.length === 0) {
      if (activePack) {
        setActivePack("");
        setAppSetting("cesp_active_pack", "").catch(() => {});
      }
      return;
    }
    if (!installed.some((p) => p.name === activePack)) {
      const first = installed[0].name;
      setActivePack(first);
      setAppSetting("cesp_active_pack", first).catch(() => {});
    }
  }, [installed, activePack, activePackLoaded]);

  const handleSoundSourceChange = async (
    source: "system" | "openpeon",
  ) => {
    setSoundSource(source);
    try {
      setError(null);
      await setAppSetting("sound_source", source);
    } catch (e) {
      setError(String(e));
    }
  };

  const handlePackChange = async (name: string) => {
    setActivePack(name);
    try {
      setError(null);
      await setAppSetting("cesp_active_pack", name);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleVolumeChange = (val: number) => {
    setVolume(val);
  };

  const handleVolumeCommit = async () => {
    try {
      await setAppSetting("cesp_volume", (volume / 100).toFixed(2));
    } catch {
      // best-effort
    }
  };

  const handleMuteToggle = async () => {
    const next = !muted;
    setMuted(next);
    try {
      await setAppSetting("cesp_muted", next ? "true" : "false");
    } catch {
      // best-effort
    }
  };

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

  const handlePreview = async (event: SoundEvent) => {
    if (muted) return;
    try {
      setError(null);
      if (soundSource === "openpeon") {
        if (activePack) {
          await cespPreviewSound(activePack, event.cespCategory);
        }
      } else {
        await playNotificationSound(sounds[event.key], volume / 100);
      }
    } catch (e) {
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

  const isOpenPeon = soundSource === "openpeon";
  const hasPacks = installed.length > 0;
  const noPacks = isOpenPeon && !hasPacks;

  return (
    <div>
      <h2 className={styles.sectionTitle}>Notifications</h2>

      {/* 1. Sound source */}
      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Sound source</div>
          <div className={styles.settingDescription}>
            Choose between system notification sounds or community sound packs.
          </div>
        </div>
        <div className={styles.settingControl}>
          <label className={styles.radioLabel}>
            <input
              type="radio"
              name="sound-source"
              checked={!isOpenPeon}
              onChange={() => handleSoundSourceChange("system")}
            />
            System sounds
          </label>
          <label className={styles.radioLabel}>
            <input
              type="radio"
              name="sound-source"
              checked={isOpenPeon}
              onChange={() => handleSoundSourceChange("openpeon")}
            />
            Sound packs (OpenPeon)
          </label>
        </div>
      </div>

      {/* 2. Mode-specific block */}
      <div
        className={`${styles.modeBlock} ${!isOpenPeon ? styles.modeBlockCollapsed : ""}`}
      >
        <div className={styles.modeBlockInner}>
          {isOpenPeon && !hasPacks ? (
            /* Mode B: empty-state card */
            <div
              className={styles.emptyStateCard}
              onClick={() => setShowBrowser(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setShowBrowser(true);
                }
              }}
            >
              <div className={styles.emptyStateTitle}>
                No sound packs installed yet
              </div>
              <div className={styles.emptyStateSubtitle}>
                Browse 100+ community sound packs to customize your
                notifications.
              </div>
              <span className={styles.emptyStateCta}>Browse packs →</span>
            </div>
          ) : isOpenPeon ? (
            /* Mode C: active pack selector + browse link */
            <div className={styles.settingRow}>
              <div className={styles.settingInfo}>
                <div className={styles.settingLabel}>Active pack</div>
                <div className={styles.settingDescription}>
                  Choose which installed sound pack to use.
                </div>
              </div>
              <div className={styles.settingControl}>
                <div className={styles.inlineControl}>
                  <select
                    className={styles.select}
                    value={activePack}
                    onChange={(e) => handlePackChange(e.target.value)}
                  >
                    {installed.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.display_name}
                      </option>
                    ))}
                  </select>
                  <button
                    className={styles.browseMoreLink}
                    onClick={() => setShowBrowser(true)}
                  >
                    Browse more →
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {isOpenPeon && showBrowser && (
            <>
              <div
                className={styles.settingRow}
                style={{ borderBottom: "none", paddingBottom: 0 }}
              >
                <div className={styles.settingInfo}>
                  <div className={styles.settingLabel}>
                    Sound pack registry
                  </div>
                  <div className={styles.settingDescription}>
                    Install, update, or remove sound packs from the OpenPeon
                    registry.
                  </div>
                </div>
                <div className={styles.settingControl}>
                  <button
                    className={styles.iconBtn}
                    onClick={() => setShowBrowser(false)}
                  >
                    Close
                  </button>
                </div>
              </div>
              <SoundPackBrowser
                installed={installed}
                onChanged={loadInstalled}
              />
            </>
          )}
        </div>
      </div>

      {/* 3. Volume */}
      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Volume</div>
          <div className={styles.settingDescription}>
            Master volume for notification sound playback.
          </div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.inlineControl}>
            <input
              type="range"
              className={styles.volumeSlider}
              min={0}
              max={100}
              value={volume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              onPointerUp={handleVolumeCommit}
              onKeyUp={handleVolumeCommit}
              aria-label="Notification volume"
            />
            <span className={styles.volumeValue}>{volume}%</span>
          </div>
        </div>
      </div>

      {/* 4. Mute all sounds */}
      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Mute all sounds</div>
          <div className={styles.settingDescription}>
            Silence all notification sounds without changing other settings.
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            data-checked={muted}
            onClick={handleMuteToggle}
            role="switch"
            aria-checked={muted}
            aria-label="Mute all sounds"
          >
            <span className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      {/* 5. Event sounds */}
      <div
        className={styles.settingRow}
        style={{ borderBottom: "none", paddingBottom: 4 }}
      >
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Event sounds</div>
          <div className={styles.settingDescription}>
            {noPacks
              ? "Install a pack to configure event sounds."
              : "Configure the sound played for each notification event."}
          </div>
        </div>
      </div>
      {SOUND_EVENTS.map((event) => (
        <div
          key={event.key}
          className={`${styles.settingRow} ${noPacks ? styles.eventRowDisabled : ""}`}
          style={{ padding: "10px 0" }}
        >
          <div className={styles.settingInfo}>
            <div className={styles.settingLabel} style={{ fontSize: 13 }}>
              {event.label}
            </div>
            <div className={styles.settingDescription}>
              {event.description}
            </div>
          </div>
          <div className={styles.settingControl}>
            <div className={styles.inlineControl}>
              {soundSource === "system" ? (
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
              ) : (
                <span
                  className={styles.settingDescription}
                  style={{ margin: 0 }}
                >
                  {noPacks ? "— no pack —" : "From active pack"}
                </span>
              )}
              {!noPacks && (
                <button
                  className={styles.iconBtn}
                  onClick={() => handlePreview(event)}
                  disabled={isOpenPeon && !activePack}
                  title={`Preview ${event.label}`}
                  aria-label={`Preview ${event.label} sound`}
                >
                  &#9654;
                </button>
              )}
            </div>
          </div>
        </div>
      ))}

      {error && <div className={styles.error}>{error}</div>}

      {/* 6. Notification command */}
      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Notification command</div>
          <div className={styles.settingDescription}>
            Run a shell command when a notification arrives. Workspace
            environment variables ($CLAUDETTE_WORKSPACE_NAME,
            $CLAUDETTE_WORKSPACE_PATH, etc.) are set.
          </div>
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
