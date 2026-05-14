import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/useAppStore";
import { getAppSetting, setAppSetting } from "../../../services/tauri";
import {
  applyUpdateChannel,
  checkForUpdate,
  installNow,
  installWhenIdle,
} from "../../../hooks/useAutoUpdater";
import i18n, { isSupportedLanguage } from "../../../i18n";
import styles from "../Settings.module.css";

export function GeneralSettings() {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const worktreeBaseDir = useAppStore((s) => s.worktreeBaseDir);
  const setWorktreeBaseDir = useAppStore((s) => s.setWorktreeBaseDir);
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const updateVersion = useAppStore((s) => s.updateVersion);
  const updateChannel = useAppStore((s) => s.updateChannel);
  const updateDownloading = useAppStore((s) => s.updateDownloading);
  const updateProgress = useAppStore((s) => s.updateProgress);
  const updateInstallWhenIdle = useAppStore((s) => s.updateInstallWhenIdle);
  const openModal = useAppStore((s) => s.openModal);

  // While an install is in flight (downloading, or queued to install when
  // agents go idle), changing the channel would silently swap the endpoint
  // for an update that's already on its way. Lock the dropdown until that
  // resolves (the app restarts after install, so this is short-lived).
  const channelLocked = updateDownloading || updateInstallWhenIdle;

  const [path, setPath] = useState(worktreeBaseDir);
  const [trayEnabled, setTrayEnabled] = useState(true);
  const [trayIconStyle, setTrayIconStyle] = useState<
    "auto" | "light" | "dark" | "color"
  >("auto");
  const [archiveOnMerge, setArchiveOnMerge] = useState(false);
  const [language, setLanguageState] = useState("en");
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [checkState, setCheckState] = useState<"idle" | "checking" | "up-to-date">("idle");

  useEffect(() => {
    setPath(worktreeBaseDir);
  }, [worktreeBaseDir]);

  useEffect(() => {
    getAppSetting("tray_enabled")
      .then((val) => setTrayEnabled(val !== "false"))
      .catch(() => {});
    getAppSetting("tray_icon_style")
      .then((val) => {
        if (val === "light" || val === "dark" || val === "color") {
          setTrayIconStyle(val);
        } else {
          setTrayIconStyle("auto");
        }
      })
      .catch(() => {});
    getAppSetting("archive_on_merge")
      .then((val) => setArchiveOnMerge(val === "true"))
      .catch(() => {});
    getAppSetting("language")
      .then((val) => { if (val && isSupportedLanguage(val)) setLanguageState(val); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // Auto-reset "up to date" message after 4 seconds.
  useEffect(() => {
    if (checkState !== "up-to-date") return;
    const timer = setTimeout(() => setCheckState("idle"), 4000);
    return () => clearTimeout(timer);
  }, [checkState]);

  // If an update becomes available (e.g. from the banner), reset to idle.
  useEffect(() => {
    if (updateAvailable) setCheckState("idle");
  }, [updateAvailable]);

  const handleCheckForUpdates = async () => {
    setError(null);
    setCheckState("checking");
    const result = await checkForUpdate();
    if (result === "up-to-date") {
      setCheckState("up-to-date");
    } else if (result === "error") {
      setCheckState("idle");
      setError(t("general_update_check_failed"));
    } else {
      // "available" — the inline install controls below pick it up. Reset
      // the button so it doesn't stick on "Checking…". The fallback
      // useEffect on `updateAvailable` only fires on transitions, so it
      // can't recover when the auto-check has already cached the same
      // update.
      setCheckState("idle");
    }
  };

  const handlePathBlur = async () => {
    const trimmed = path.trim();
    if (trimmed && trimmed !== worktreeBaseDir) {
      try {
        setError(null);
        await setAppSetting("worktree_base_dir", trimmed);
        setWorktreeBaseDir(trimmed);
      } catch (e) {
        setError(String(e));
      }
    }
  };

  const handleTrayToggle = async () => {
    const next = !trayEnabled;
    setTrayEnabled(next);
    try {
      setError(null);
      await setAppSetting("tray_enabled", next ? "true" : "false");
    } catch (e) {
      setTrayEnabled(!next);
      setError(String(e));
    }
  };

  const handleArchiveOnMergeToggle = async () => {
    const next = !archiveOnMerge;
    setArchiveOnMerge(next);
    try {
      setError(null);
      await setAppSetting("archive_on_merge", next ? "true" : "false");
    } catch (e) {
      setArchiveOnMerge(!next);
      setError(String(e));
    }
  };

  const handleTrayIconStyleChange = async (
    next: "auto" | "light" | "dark" | "color",
  ) => {
    const previous = trayIconStyle;
    setTrayIconStyle(next);
    try {
      setError(null);
      await setAppSetting("tray_icon_style", next);
    } catch (e) {
      setTrayIconStyle(previous);
      setError(String(e));
    }
  };

  const handleUpdateChannelChange = async (next: "stable" | "nightly") => {
    if (next === updateChannel) return;
    if (next === "nightly") {
      // Nightly opt-in is gated behind a confirmation modal; the modal owns
      // the persist + store update on confirm.
      openModal("confirmNightlyChannel");
      return;
    }
    try {
      setError(null);
      await applyUpdateChannel(next);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleLanguageChange = async (next: string) => {
    const prev = language;
    setLanguageState(next);
    try {
      setError(null);
      await setAppSetting("language", next);
      await i18n.changeLanguage(next);
    } catch (e) {
      setLanguageState(prev);
      setError(String(e));
    }
  };

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("general_title")}</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("general_app_version")}</div>
          <div className={styles.settingDescription}>
            {appVersion ? `v${appVersion}` : "…"}
            {updateAvailable && updateVersion
              ? ` ${t("general_update_available_suffix", { version: updateVersion })}`
              : ""}
          </div>
        </div>
        <div className={styles.settingControl}>
          {updateDownloading ? (
            <button className={styles.iconBtn} disabled>
              {t("general_downloading", { progress: updateProgress })}
            </button>
          ) : updateAvailable && updateVersion ? (
            <div className={styles.inlineControl}>
              <button className={styles.iconBtn} onClick={installNow}>
                {t("general_install_now")}
              </button>
              {!updateInstallWhenIdle && (
                <button className={styles.iconBtn} onClick={installWhenIdle}>
                  {t("general_when_idle")}
                </button>
              )}
            </div>
          ) : (
            <button
              className={styles.iconBtn}
              onClick={handleCheckForUpdates}
              disabled={checkState === "checking"}
            >
              {checkState === "checking"
                ? t("general_checking")
                : checkState === "up-to-date"
                  ? t("general_up_to_date")
                  : t("general_check_updates")}
            </button>
          )}
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("general_update_channel")}</div>
          <div className={styles.settingDescription}>
            {channelLocked
              ? t("general_channel_locked")
              : t("general_channel_nightly_hint")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            className={styles.select}
            value={updateChannel}
            aria-label={t("general_update_channel")}
            disabled={channelLocked}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "stable" || value === "nightly") {
                handleUpdateChannelChange(value);
              }
            }}
          >
            <option value="stable">{t("general_channel_stable")}</option>
            <option value="nightly">{t("general_channel_nightly")}</option>
          </select>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("general_worktree_dir")}</div>
          <div className={styles.settingDescription}>
            {t("general_worktree_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.inlineControl}>
            <input
              className={styles.input}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onBlur={handlePathBlur}
              placeholder={t("general_worktree_placeholder")}
            />
            <button
              className={styles.iconBtn}
              onClick={async () => {
                try {
                  const selected = await open({ directory: true, multiple: false });
                  if (selected) {
                    setPath(selected);
                    setError(null);
                    await setAppSetting("worktree_base_dir", selected);
                    setWorktreeBaseDir(selected);
                  }
                } catch (e) {
                  setError(String(e));
                }
              }}
              title={tCommon("browse")}
            >
              <FolderOpen size={14} />
            </button>
          </div>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("general_archive_on_merge")}</div>
          <div className={styles.settingDescription}>
            {t("general_archive_on_merge_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={archiveOnMerge}
            aria-label={t("general_archive_on_merge")}
            data-checked={archiveOnMerge}
            onClick={handleArchiveOnMergeToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("general_system_tray")}</div>
          <div className={styles.settingDescription}>
            {t("general_system_tray_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={trayEnabled}
            aria-label={t("general_system_tray")}
            data-checked={trayEnabled}
            onClick={handleTrayToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("general_tray_icon_style")}</div>
          <div className={styles.settingDescription}>
            {t("general_tray_icon_style_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            className={styles.select}
            value={trayIconStyle}
            aria-label={t("general_tray_icon_style")}
            disabled={!trayEnabled}
            onChange={(e) => {
              // The <select> options below only emit these four values,
              // but validate at runtime anyway — avoids persisting a
              // surprise value if the DOM gets manipulated by an
              // extension or the options list ever changes shape.
              const value = e.target.value;
              if (
                value === "auto" ||
                value === "light" ||
                value === "dark" ||
                value === "color"
              ) {
                handleTrayIconStyleChange(value);
              }
            }}
          >
            <option value="auto">{t("general_tray_auto")}</option>
            <option value="light">{t("general_tray_light")}</option>
            <option value="dark">{t("general_tray_dark")}</option>
            <option value="color">{t("general_tray_color")}</option>
          </select>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("general_language")}</div>
          <div className={styles.settingDescription}>
            {t("general_language_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            className={styles.select}
            value={language}
            aria-label={t("general_language")}
            onChange={(e) => void handleLanguageChange(e.target.value)}
          >
            <option value="en">{t("general_language_en")}</option>
            <option value="es">{t("general_language_es")}</option>
            <option value="pt-BR">{t("general_language_pt_br")}</option>
            <option value="ja">{t("general_language_ja")}</option>
            <option value="zh-CN">{t("general_language_zh_cn")}</option>
          </select>
        </div>
      </div>
    </div>
  );
}
