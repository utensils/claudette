import { useEffect, useState } from "react";
import { FolderOpen, RotateCcw } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { useAppStore } from "../../../stores/useAppStore";
import {
  getAppSetting,
  setAppSetting,
  getDataDirInfo,
  setDataDir,
} from "../../../services/tauri";
import type { DataDirInfo } from "../../../services/tauri";
import { checkForUpdate } from "../../../hooks/useAutoUpdater";
import styles from "../Settings.module.css";

export function GeneralSettings() {
  const worktreeBaseDir = useAppStore((s) => s.worktreeBaseDir);
  const setWorktreeBaseDir = useAppStore((s) => s.setWorktreeBaseDir);
  const updateAvailable = useAppStore((s) => s.updateAvailable);

  const [path, setPath] = useState(worktreeBaseDir);
  const [trayEnabled, setTrayEnabled] = useState(true);
  const [trayIconStyle, setTrayIconStyle] = useState<
    "auto" | "light" | "dark" | "color"
  >("auto");
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [checkState, setCheckState] = useState<"idle" | "checking" | "up-to-date">("idle");

  // Data directory state
  const [dataDirInfo, setDataDirInfo] = useState<DataDirInfo | null>(null);
  const [dataDirInput, setDataDirInput] = useState("");
  const [dataDirChanged, setDataDirChanged] = useState(false);

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

  // Load data directory info on mount.
  useEffect(() => {
    getDataDirInfo()
      .then((info) => {
        setDataDirInfo(info);
        setDataDirInput(info.configured ?? info.current);
      })
      .catch(() => {});
  }, []);

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

  const handleDataDirBlur = async () => {
    const trimmed = dataDirInput.trim();
    if (!dataDirInfo || !trimmed) return;
    // If the input matches the current active dir and there's no existing
    // override, nothing to do.
    if (trimmed === dataDirInfo.current && !dataDirInfo.configured) return;
    try {
      setError(null);
      await setDataDir(trimmed);
      setDataDirInfo((prev) => prev ? { ...prev, configured: trimmed } : prev);
      setDataDirChanged(trimmed !== dataDirInfo.current);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDataDirReset = async () => {
    if (!dataDirInfo) return;
    try {
      setError(null);
      await setDataDir(null);
      setDataDirInput(dataDirInfo.current);
      setDataDirInfo((prev) => prev ? { ...prev, configured: null } : prev);
      setDataDirChanged(false);
    } catch (e) {
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
          <div className={styles.settingLabel}>Data directory</div>
          <div className={styles.settingDescription}>
            Where Claudette stores its data (database, themes, apps config).
            Existing data is not moved automatically.
            {dataDirInfo?.env_override && (
              <>
                <br />
                <span style={{ color: "var(--text-tertiary)" }}>
                  Overridden by CLAUDETTE_DATA_DIR environment variable
                </span>
              </>
            )}
          </div>
        </div>
        <div className={styles.settingControl}>
          {dataDirInfo?.env_override ? (
            <span className={styles.input} style={{ opacity: 0.6 }}>
              {dataDirInfo.current}
            </span>
          ) : (
            <div className={styles.inlineControl}>
              <input
                className={styles.input}
                value={dataDirInput}
                onChange={(e) => setDataDirInput(e.target.value)}
                onBlur={handleDataDirBlur}
                placeholder={dataDirInfo?.current ?? ""}
              />
              <button
                className={styles.iconBtn}
                onClick={async () => {
                  try {
                    const selected = await open({
                      directory: true,
                      multiple: false,
                    });
                    if (selected && dataDirInfo) {
                      setDataDirInput(selected);
                      setError(null);
                      await setDataDir(selected);
                      setDataDirInfo((prev) =>
                        prev ? { ...prev, configured: selected } : prev,
                      );
                      setDataDirChanged(selected !== dataDirInfo.current);
                    }
                  } catch (e) {
                    setError(String(e));
                  }
                }}
                title="Browse"
              >
                <FolderOpen size={14} />
              </button>
              {dataDirInfo?.configured && (
                <button
                  className={styles.iconBtn}
                  onClick={handleDataDirReset}
                  title="Reset to default"
                >
                  <RotateCcw size={14} />
                </button>
              )}
            </div>
          )}
          {dataDirChanged && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 6,
              }}
            >
              <span
                style={{
                  fontSize: "0.8em",
                  color: "var(--text-warning, var(--text-tertiary))",
                }}
              >
                Restart required
              </span>
              <button className={styles.iconBtn} onClick={() => relaunch()}>
                Restart now
              </button>
            </div>
          )}
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
