import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "../../../stores/useAppStore";
import { getAppSetting, setAppSetting } from "../../../services/tauri";
import { applyUpdateChannel, checkForUpdate } from "../../../hooks/useAutoUpdater";
import styles from "../Settings.module.css";

export function GeneralSettings() {
  const worktreeBaseDir = useAppStore((s) => s.worktreeBaseDir);
  const setWorktreeBaseDir = useAppStore((s) => s.setWorktreeBaseDir);
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const updateChannel = useAppStore((s) => s.updateChannel);
  const openModal = useAppStore((s) => s.openModal);

  const [path, setPath] = useState(worktreeBaseDir);
  const [trayEnabled, setTrayEnabled] = useState(true);
  const [trayIconStyle, setTrayIconStyle] = useState<
    "auto" | "light" | "dark" | "color"
  >("auto");
  const [archiveOnMerge, setArchiveOnMerge] = useState(false);
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
      setError("Update check failed. Please try again later.");
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

  return (
    <div>
      <h2 className={styles.sectionTitle}>General</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>App version</div>
          <div className={styles.settingDescription}>
            {appVersion ? `v${appVersion}` : "\u2026"}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.iconBtn}
            onClick={handleCheckForUpdates}
            disabled={checkState === "checking"}
          >
            {checkState === "checking"
              ? "Checking\u2026"
              : checkState === "up-to-date"
                ? "Up to date"
                : "Check for Updates"}
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Update channel</div>
          <div className={styles.settingDescription}>
            Nightly builds include the latest features and fixes but may be
            unstable.
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            className={styles.select}
            value={updateChannel}
            aria-label="Update channel"
            onChange={(e) => {
              const value = e.target.value;
              if (value === "stable" || value === "nightly") {
                handleUpdateChannelChange(value);
              }
            }}
          >
            <option value="stable">Stable (recommended)</option>
            <option value="nightly">Nightly (latest main)</option>
          </select>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Worktree base directory</div>
          <div className={styles.settingDescription}>
            Where new workspaces are created
          </div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.inlineControl}>
            <input
              className={styles.input}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onBlur={handlePathBlur}
              placeholder="~/.claudette/workspaces"
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
              title="Browse"
            >
              <FolderOpen size={14} />
            </button>
          </div>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Archive on merge</div>
          <div className={styles.settingDescription}>
            Automatically archive a workspace when its pull request is merged.
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={archiveOnMerge}
            aria-label="Archive on merge"
            data-checked={archiveOnMerge}
            onClick={handleArchiveOnMergeToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>System tray</div>
          <div className={styles.settingDescription}>
            Show Claudette in the system tray. Closing the window will minimize
            to tray when enabled.
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={trayEnabled}
            aria-label="System tray"
            data-checked={trayEnabled}
            onClick={handleTrayToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Tray icon style</div>
          <div className={styles.settingDescription}>
            Auto uses macOS template tinting (black or white depending on the
            menu bar) and the logo's orange on Linux. Pick Light for a white
            icon on dark panels, Dark for a black icon on light panels, or
            Color to use the orange on every platform.
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            className={styles.select}
            value={trayIconStyle}
            aria-label="Tray icon style"
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
            <option value="auto">Auto</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="color">Color</option>
          </select>
        </div>
      </div>
    </div>
  );
}
