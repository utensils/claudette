import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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

const SOUND_EVENTS = [
  {
    key: "notification_sound_ask",
    cespCategory: "input.required",
    labelKey: "notifications_sound_ask_label" as const,
    descKey: "notifications_sound_ask_desc" as const,
  },
  {
    key: "notification_sound_plan",
    cespCategory: "task.acknowledge",
    labelKey: "notifications_sound_plan_label" as const,
    descKey: "notifications_sound_plan_desc" as const,
  },
  {
    key: "notification_sound_finished",
    cespCategory: "task.complete",
    labelKey: "notifications_sound_finished_label" as const,
    descKey: "notifications_sound_finished_desc" as const,
  },
  {
    key: "notification_sound_error",
    cespCategory: "task.error",
    labelKey: "notifications_sound_error_label" as const,
    descKey: "notifications_sound_error_desc" as const,
  },
  {
    key: "notification_sound_session_start",
    cespCategory: "session.start",
    labelKey: "notifications_sound_session_start_label" as const,
    descKey: "notifications_sound_session_start_desc" as const,
  },
];

type SoundEvent = (typeof SOUND_EVENTS)[number];

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
  const { t } = useTranslation("settings");
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
      <h2 className={styles.sectionTitle}>{t("notifications_title")}</h2>

      {/* 1. Sound source */}
      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("notifications_sound_source")}</div>
          <div className={styles.settingDescription}>
            {t("notifications_sound_source_desc")}
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
            {t("notifications_system_sounds")}
          </label>
          <label className={styles.radioLabel}>
            <input
              type="radio"
              name="sound-source"
              checked={isOpenPeon}
              onChange={() => handleSoundSourceChange("openpeon")}
            />
            {t("notifications_openpeon")}
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
                {t("notifications_no_packs_title")}
              </div>
              <div className={styles.emptyStateSubtitle}>
                {t("notifications_no_packs_sub")}
              </div>
              <span className={styles.emptyStateCta}>{t("notifications_browse_packs")}</span>
            </div>
          ) : isOpenPeon ? (
            /* Mode C: active pack selector + browse link */
            <div className={styles.settingRow}>
              <div className={styles.settingInfo}>
                <div className={styles.settingLabel}>{t("notifications_active_pack")}</div>
                <div className={styles.settingDescription}>
                  {t("notifications_active_pack_desc")}
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
                    {t("notifications_browse_more")}
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
                    {t("notifications_sound_registry")}
                  </div>
                  <div className={styles.settingDescription}>
                    {t("notifications_sound_registry_desc")}
                  </div>
                </div>
                <div className={styles.settingControl}>
                  <button
                    className={styles.iconBtn}
                    onClick={() => setShowBrowser(false)}
                  >
                    {t("notifications_sound_registry_close")}
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
          <div className={styles.settingLabel}>{t("notifications_volume")}</div>
          <div className={styles.settingDescription}>
            {t("notifications_volume_desc")}
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
              aria-label={t("notifications_volume_aria")}
            />
            <span className={styles.volumeValue}>{volume}%</span>
          </div>
        </div>
      </div>

      {/* 4. Mute all sounds */}
      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("notifications_mute")}</div>
          <div className={styles.settingDescription}>
            {t("notifications_mute_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            data-checked={muted}
            onClick={handleMuteToggle}
            role="switch"
            aria-checked={muted}
            aria-label={t("notifications_mute")}
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
          <div className={styles.settingLabel}>{t("notifications_event_sounds")}</div>
          <div className={styles.settingDescription}>
            {noPacks
              ? t("notifications_event_sounds_desc_install")
              : t("notifications_event_sounds_desc_configure")}
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
              {t(event.labelKey)}
            </div>
            <div className={styles.settingDescription}>
              {t(event.descKey)}
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
                  {noPacks ? t("notifications_no_pack") : t("notifications_from_active_pack")}
                </span>
              )}
              {!noPacks && (
                <button
                  className={styles.iconBtn}
                  onClick={() => handlePreview(event)}
                  disabled={isOpenPeon && !activePack}
                  title={t("notifications_preview", { label: t(event.labelKey) })}
                  aria-label={t("notifications_preview_aria", { label: t(event.labelKey) })}
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
          <div className={styles.settingLabel}>{t("notifications_command")}</div>
          <div className={styles.settingDescription}>
            {t("notifications_command_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.inlineControl}>
            <input
              className={styles.input}
              value={notificationCommand}
              onChange={(e) => setNotificationCommand(e.target.value)}
              onBlur={handleCommandBlur}
              placeholder={t("notifications_command_placeholder")}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button
              className={styles.iconBtn}
              disabled={!notificationCommand.trim()}
              onClick={handleTestCommand}
              title={t("notifications_test_command")}
              aria-label={t("notifications_test_command")}
            >
              &#9654;
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
