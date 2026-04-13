import { useEffect, useState } from "react";
import {
  getAppSetting,
  setAppSetting,
  getGitUsername,
} from "../../../services/tauri";
import styles from "../Settings.module.css";

type PrefixMode = "username" | "custom" | "none";

export function GitSettings() {
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
    ? `Git username (${gitUsername})`
    : "Git username";

  return (
    <div>
      <h2 className={styles.sectionTitle}>Git</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>Branch name prefix</div>
        <div className={styles.fieldHint} style={{ marginBottom: 12 }}>
          Prefix for new workspace branch names.
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
          <span>Custom</span>
        </label>

        {prefixMode === "custom" && (
          <input
            className={styles.input}
            value={customPrefix}
            onChange={(e) => setCustomPrefix(e.target.value)}
            onBlur={handleCustomPrefixBlur}
            placeholder="e.g. feature/ or myname/"
            style={{ marginLeft: 24, marginTop: 4, maxWidth: 260 }}
          />
        )}

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="prefix-mode"
            checked={prefixMode === "none"}
            onChange={() => handleModeChange("none")}
          />
          <span>None</span>
        </label>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Delete branch on archive</div>
          <div className={styles.settingDescription}>
            Delete the local branch when archiving a workspace.
          </div>
          {deleteBranch && (
            <div
              className={styles.settingDescription}
              style={{ color: "var(--status-stopped)", marginTop: 4 }}
            >
              The branch will be permanently deleted, including any unmerged commits.
            </div>
          )}
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={deleteBranch}
            aria-label="Delete branch on archive"
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
