import { useEffect, useState } from "react";
import { getAppSetting, setAppSetting } from "../../../services/tauri";
import { MODELS } from "../../chat/ModelSelector";
import { EFFORT_LEVELS, isEffortSupported, isMaxEffortAllowed } from "../../chat/EffortSelector";
import styles from "../Settings.module.css";

export function ModelSettings() {
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
    // Normalize effort when model changes
    if (!isEffortSupported(model)) {
      setDefaultEffort("auto");
      await saveSetting("default_effort", "auto");
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
  const availableEffortLevels = isMaxEffortAllowed(defaultModel)
    ? EFFORT_LEVELS
    : EFFORT_LEVELS.filter((l) => l.id !== "max");
  const effortDisabled = !isEffortSupported(defaultModel);

  return (
    <div>
      <h2 className={styles.sectionTitle}>Models</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Default model</div>
          <div className={styles.settingDescription}>
            Model for new chats
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
              className={styles.select}
              value={defaultThinking ? "true" : "false"}
              onChange={(e) => handleThinkingChange(e.target.value)}
              style={{ minWidth: 130 }}
            >
              <option value="false">Thinking off</option>
              <option value="true">Thinking on</option>
            </select>
          </div>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Default effort level</div>
          <div className={styles.settingDescription}>
            Reasoning effort for new chats
            {effortDisabled && " (not supported by selected model)"}
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            className={styles.select}
            value={defaultEffort}
            onChange={(e) => handleEffortChange(e.target.value)}
            disabled={effortDisabled}
            style={{ opacity: effortDisabled ? 0.5 : 1 }}
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
          <div className={styles.settingLabel}>Show thinking blocks</div>
          <div className={styles.settingDescription}>
            Display model thinking in chat by default
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={defaultShowThinking}
            aria-label="Show thinking blocks"
            data-checked={defaultShowThinking}
            onClick={handleToggle(defaultShowThinking, setDefaultShowThinking, "default_show_thinking")}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Default to plan mode</div>
          <div className={styles.settingDescription}>
            Start new chats in plan mode
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={defaultPlanMode}
            aria-label="Default to plan mode"
            data-checked={defaultPlanMode}
            onClick={handleToggle(defaultPlanMode, setDefaultPlanMode, "default_plan_mode")}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Default to fast mode</div>
          <div className={styles.settingDescription}>
            Start new chats in fast mode
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={defaultFastMode}
            aria-label="Default to fast mode"
            data-checked={defaultFastMode}
            onClick={handleToggle(defaultFastMode, setDefaultFastMode, "default_fast_mode")}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Use Claude Code with Chrome</div>
          <div className={styles.settingDescription}>
            Allow Claude Code to control your Chrome browser. To use this feature, first install the Claude Code Chrome extension.
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={defaultChrome}
            aria-label="Use Claude Code with Chrome"
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
