import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getAppSetting,
  setAppSetting,
  getGitUsername,
} from "../../../services/tauri";
import styles from "../Settings.module.css";

type PrefixMode = "username" | "custom" | "none";

export function GitSettings() {
  const { t } = useTranslation("settings");
  const [prefixMode, setPrefixMode] = useState<PrefixMode>("username");
  const [customPrefix, setCustomPrefix] = useState("");
  const [gitUsername, setGitUsername] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getGitUsername()
      .then(setGitUsername)
      .catch(() => setGitUsername(null));
    getAppSetting("git_branch_prefix_mode")
      .then((val) => {
        if (val === "custom" || val === "none" || val === "username") {
          setPrefixMode(val);
        }
      })
      .catch(() => {});
    getAppSetting("git_branch_prefix_custom")
      .then((val) => {
        if (val) setCustomPrefix(val);
      })
      .catch(() => {});
    getAppSetting("git_delete_branch_on_archive")
      .then((val) => setDeleteBranch(val === "true"))
      .catch(() => {});
  }, []);

  const handleModeChange = async (mode: PrefixMode) => {
    setPrefixMode(mode);
    try {
      setError(null);
      await setAppSetting("git_branch_prefix_mode", mode);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCustomPrefixBlur = async () => {
    try {
      setError(null);
      await setAppSetting("git_branch_prefix_custom", customPrefix);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDeleteBranchToggle = async () => {
    const next = !deleteBranch;
    setDeleteBranch(next);
    try {
      setError(null);
      await setAppSetting(
        "git_delete_branch_on_archive",
        next ? "true" : "false"
      );
    } catch (e) {
      setDeleteBranch(!next);
      setError(String(e));
    }
  };

  const usernameLabel = gitUsername
    ? t("git_prefix_username", { username: gitUsername })
    : t("git_prefix_username_no_git");

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("git_title")}</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>{t("git_branch_prefix")}</div>
        <div className={`${styles.fieldHint} ${styles.fieldHintSpacedWide}`}>
          {t("git_branch_prefix_desc")}
        </div>

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="prefix-mode"
            checked={prefixMode === "username"}
            onChange={() => handleModeChange("username")}
          />
          <span>{usernameLabel}</span>
        </label>

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="prefix-mode"
            checked={prefixMode === "custom"}
            onChange={() => handleModeChange("custom")}
          />
          <span>{t("git_prefix_custom")}</span>
        </label>

        {prefixMode === "custom" && (
          <input
            className={`${styles.input} ${styles.customPrefixInput}`}
            value={customPrefix}
            onChange={(e) => setCustomPrefix(e.target.value)}
            onBlur={handleCustomPrefixBlur}
            placeholder={t("git_prefix_placeholder")}
          />
        )}

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="prefix-mode"
            checked={prefixMode === "none"}
            onChange={() => handleModeChange("none")}
          />
          <span>{t("git_prefix_none")}</span>
        </label>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("git_delete_branch")}</div>
          <div className={styles.settingDescription}>
            {t("git_delete_branch_desc")}
          </div>
          {deleteBranch && (
            <div className={`${styles.settingDescription} ${styles.gitWarning}`}>
              {t("git_delete_warning")}
            </div>
          )}
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={deleteBranch}
            aria-label={t("git_delete_branch_aria")}
            data-checked={deleteBranch}
            onClick={handleDeleteBranchToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>
    </div>
  );
}
