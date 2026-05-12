import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getAppSetting,
  setAppSetting,
  getGitUsername,
} from "../../../services/tauri";
import { MODELS } from "../../chat/ModelSelector";
import styles from "../Settings.module.css";

type PrefixMode = "username" | "custom" | "none";

const DEFAULT_CI_PROMPT_PLACEHOLDER = `CI has failed on this branch. Please analyze the failures and fix the issues.

## Failed checks
{{failed_checks}}

## Failure logs
{{failure_logs}}

Branch: {{branch}}
PR: {{pr_title}} ({{pr_url}})

Investigate the failing checks, identify the root cause, and make the necessary code changes to fix the CI failures.`;

export function GitSettings() {
  const { t } = useTranslation("settings");
  const [prefixMode, setPrefixMode] = useState<PrefixMode>("username");
  const [customPrefix, setCustomPrefix] = useState("");
  const [gitUsername, setGitUsername] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [ciAutoFix, setCiAutoFix] = useState(false);
  const [ciPrompt, setCiPrompt] = useState("");
  const [ciCooldown, setCiCooldown] = useState("300");
  const [ciModel, setCiModel] = useState("");
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
    getAppSetting("ci_auto_fix_enabled")
      .then((val) => setCiAutoFix(val === "true"))
      .catch(() => {});
    getAppSetting("ci_auto_fix_prompt")
      .then((val) => { if (val) setCiPrompt(val); })
      .catch(() => {});
    getAppSetting("ci_auto_fix_cooldown_seconds")
      .then((val) => { if (val) setCiCooldown(val); })
      .catch(() => {});
    getAppSetting("ci_auto_fix_model")
      .then((val) => { if (val) setCiModel(val); })
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

  const handleCiAutoFixToggle = async () => {
    const next = !ciAutoFix;
    setCiAutoFix(next);
    try {
      setError(null);
      await setAppSetting("ci_auto_fix_enabled", next ? "true" : "false");
    } catch (e) {
      setCiAutoFix(!next);
      setError(String(e));
    }
  };

  const handleCiPromptBlur = async () => {
    try {
      setError(null);
      await setAppSetting("ci_auto_fix_prompt", ciPrompt);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCiModelChange = async (model: string) => {
    setCiModel(model);
    try {
      setError(null);
      await setAppSetting("ci_auto_fix_model", model);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCiCooldownBlur = async () => {
    const parsed = parseInt(ciCooldown, 10);
    const clamped = Math.max(60, Math.min(3600, isNaN(parsed) ? 300 : parsed));
    setCiCooldown(String(clamped));
    try {
      setError(null);
      await setAppSetting("ci_auto_fix_cooldown_seconds", String(clamped));
    } catch (e) {
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

      <h3 className={styles.subsectionTitle}>CI Automation</h3>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Auto-fix CI failures</div>
          <div className={styles.settingDescription}>
            Automatically create a new session with a prompt to fix failing CI
            checks when all checks have completed and at least one has failed.
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={ciAutoFix}
            aria-label="Auto-fix CI failures"
            data-checked={ciAutoFix}
            onClick={handleCiAutoFixToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      {ciAutoFix && (
        <>
          <div className={styles.fieldGroup}>
            <div className={styles.fieldLabel}>Model</div>
            <div className={`${styles.fieldHint} ${styles.fieldHintSpacedWide}`}>
              Model used by auto-fix sessions. Defaults to your global default model when unset.
            </div>
            <select
              className={styles.select}
              value={ciModel}
              onChange={(e) => handleCiModelChange(e.target.value)}
            >
              <option value="">Use default model</option>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.fieldGroup}>
            <div className={styles.fieldLabel}>Prompt template</div>
            <div className={`${styles.fieldHint} ${styles.fieldHintSpacedWide}`}>
              Template for the auto-fix prompt. Use {"{{failed_checks}}"}, {"{{failure_logs}}"}, {"{{branch}}"}, {"{{pr_title}}"}, {"{{pr_url}}"}, {"{{pr_number}}"}, and {"{{all_checks}}"} as variables.
            </div>
            <textarea
              className={styles.textarea}
              value={ciPrompt}
              onChange={(e) => setCiPrompt(e.target.value)}
              onBlur={handleCiPromptBlur}
              placeholder={DEFAULT_CI_PROMPT_PLACEHOLDER}
              rows={10}
            />
          </div>

          <div className={styles.fieldGroup}>
            <div className={styles.fieldLabel}>Cooldown (seconds)</div>
            <div className={`${styles.fieldHint} ${styles.fieldHintSpacedWide}`}>
              Minimum time between auto-fix session creations per workspace (60–3600).
            </div>
            <input
              className={styles.input}
              type="number"
              min={60}
              max={3600}
              value={ciCooldown}
              onChange={(e) => setCiCooldown(e.target.value)}
              onBlur={handleCiCooldownBlur}
            />
          </div>
        </>
      )}
    </div>
  );
}
