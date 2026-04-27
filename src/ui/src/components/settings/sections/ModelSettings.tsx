import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAppSetting, setAppSetting } from "../../../services/tauri";
import { MODELS } from "../../chat/ModelSelector";
import { EFFORT_LEVELS } from "../../chat/EffortSelector";
import { isFastSupported, isEffortSupported, isXhighEffortAllowed, isMaxEffortAllowed } from "../../chat/modelCapabilities";
import styles from "../Settings.module.css";

export function ModelSettings() {
  const { t } = useTranslation("settings");
  const [defaultModel, setDefaultModel] = useState("opus");
  const [defaultThinking, setDefaultThinking] = useState(false);
  const [defaultPlanMode, setDefaultPlanMode] = useState(false);
  const [defaultFastMode, setDefaultFastMode] = useState(false);
  const [defaultChrome, setDefaultChrome] = useState(false);
  const [defaultEffort, setDefaultEffort] = useState("auto");
  const [defaultShowThinking, setDefaultShowThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAppSetting("default_model")
      .then((val) => { if (val) setDefaultModel(val); })
      .catch(() => {});
    getAppSetting("default_thinking")
      .then((val) => setDefaultThinking(val === "true"))
      .catch(() => {});
    getAppSetting("default_plan_mode")
      .then((val) => setDefaultPlanMode(val === "true"))
      .catch(() => {});
    getAppSetting("default_fast_mode")
      .then((val) => setDefaultFastMode(val === "true"))
      .catch(() => {});
    getAppSetting("default_chrome")
      .then((val) => setDefaultChrome(val === "true"))
      .catch(() => {});
    getAppSetting("default_effort")
      .then((val) => { if (val) setDefaultEffort(val); })
      .catch(() => {});
    getAppSetting("default_show_thinking")
      .then((val) => setDefaultShowThinking(val === "true"))
      .catch(() => {});
  }, []);

  const saveSetting = async (key: string, value: string) => {
    try {
      setError(null);
      await setAppSetting(key, value);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleModelChange = async (model: string) => {
    setDefaultModel(model);
    await saveSetting("default_model", model);
    // Normalize fast mode when model changes
    if (defaultFastMode && !isFastSupported(model)) {
      setDefaultFastMode(false);
      await saveSetting("default_fast_mode", "false");
    }
    // Normalize effort when model changes
    if (!isEffortSupported(model)) {
      setDefaultEffort("auto");
      await saveSetting("default_effort", "auto");
    } else if (defaultEffort === "xhigh" && !isXhighEffortAllowed(model)) {
      setDefaultEffort("high");
      await saveSetting("default_effort", "high");
    } else if (defaultEffort === "max" && !isMaxEffortAllowed(model)) {
      setDefaultEffort("high");
      await saveSetting("default_effort", "high");
    }
  };

  const handleThinkingChange = async (val: string) => {
    const enabled = val === "true";
    setDefaultThinking(enabled);
    await saveSetting("default_thinking", String(enabled));
  };

  const handleEffortChange = async (level: string) => {
    setDefaultEffort(level);
    await saveSetting("default_effort", level);
  };

  const handleToggle = (
    current: boolean,
    setter: (v: boolean) => void,
    key: string,
  ) => async () => {
    const next = !current;
    setter(next);
    try {
      setError(null);
      await setAppSetting(key, String(next));
    } catch (e) {
      setter(!next);
      setError(String(e));
    }
  };

  // Filter effort levels based on selected default model
  const availableEffortLevels = isXhighEffortAllowed(defaultModel)
    ? EFFORT_LEVELS
    : isMaxEffortAllowed(defaultModel)
      ? EFFORT_LEVELS.filter((l) => l.id !== "xhigh")
      : EFFORT_LEVELS.filter((l) => l.id !== "xhigh" && l.id !== "max");
  const effortDisabled = !isEffortSupported(defaultModel);
  const fastDisabled = !isFastSupported(defaultModel);

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("models_title")}</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("models_default_model")}</div>
          <div className={styles.settingDescription}>
            {t("models_default_model_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.inlineControl}>
            <select
              className={styles.select}
              value={defaultModel}
              onChange={(e) => handleModelChange(e.target.value)}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <select
              className={`${styles.select} ${styles.selectWide}`}
              value={defaultThinking ? "true" : "false"}
              onChange={(e) => handleThinkingChange(e.target.value)}
            >
              <option value="false">{t("models_thinking_off")}</option>
              <option value="true">{t("models_thinking_on")}</option>
            </select>
          </div>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("models_default_effort")}</div>
          <div className={styles.settingDescription}>
            {t("models_default_effort_desc")}
            {effortDisabled && t("models_effort_not_supported")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            className={`${styles.select}${effortDisabled ? ` ${styles.selectDim}` : ""}`}
            value={defaultEffort}
            onChange={(e) => handleEffortChange(e.target.value)}
            disabled={effortDisabled}
          >
            {availableEffortLevels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("models_show_thinking")}</div>
          <div className={styles.settingDescription}>
            {t("models_show_thinking_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={defaultShowThinking}
            aria-label={t("models_show_thinking")}
            data-checked={defaultShowThinking}
            onClick={handleToggle(defaultShowThinking, setDefaultShowThinking, "default_show_thinking")}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("models_default_plan_mode")}</div>
          <div className={styles.settingDescription}>
            {t("models_default_plan_mode_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={defaultPlanMode}
            aria-label={t("models_default_plan_mode")}
            data-checked={defaultPlanMode}
            onClick={handleToggle(defaultPlanMode, setDefaultPlanMode, "default_plan_mode")}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("models_default_fast_mode")}</div>
          <div className={styles.settingDescription}>
            {t("models_default_fast_mode_desc")}
            {fastDisabled && t("models_fast_not_supported")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={`${styles.toggle}${fastDisabled ? ` ${styles.selectDim}` : ""}`}
            role="switch"
            aria-checked={defaultFastMode}
            aria-label={t("models_default_fast_mode")}
            data-checked={defaultFastMode && !fastDisabled}
            disabled={fastDisabled}
            onClick={handleToggle(defaultFastMode, setDefaultFastMode, "default_fast_mode")}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("models_chrome")}</div>
          <div className={styles.settingDescription}>
            {t("models_chrome_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={defaultChrome}
            aria-label={t("models_chrome")}
            data-checked={defaultChrome}
            onClick={handleToggle(defaultChrome, setDefaultChrome, "default_chrome")}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>
    </div>
  );
}
