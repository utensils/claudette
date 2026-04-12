import { useEffect, useState } from "react";
import { getAppSetting, setAppSetting } from "../../../services/tauri";
import { MODELS } from "../../chat/ModelSelector";
import styles from "../Settings.module.css";

export function ModelSettings() {
  const [defaultModel, setDefaultModel] = useState("opus");
  const [defaultThinking, setDefaultThinking] = useState(false);
  const [defaultPlanMode, setDefaultPlanMode] = useState(false);
  const [defaultFastMode, setDefaultFastMode] = useState(false);
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
  }, []);

  const handleModelChange = async (model: string) => {
    setDefaultModel(model);
    try {
      setError(null);
      await setAppSetting("default_model", model);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleThinkingChange = async (val: string) => {
    const enabled = val === "true";
    setDefaultThinking(enabled);
    try {
      setError(null);
      await setAppSetting("default_thinking", String(enabled));
    } catch (e) {
      setError(String(e));
    }
  };

  const makeToggleHandler = (
    setter: (v: boolean) => void,
    key: string,
  ) => async () => {
    const next = key === "default_plan_mode" ? !defaultPlanMode : !defaultFastMode;
    setter(next);
    try {
      setError(null);
      await setAppSetting(key, String(next));
    } catch (e) {
      setter(!next);
      setError(String(e));
    }
  };

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
            onClick={makeToggleHandler(setDefaultPlanMode, "default_plan_mode")}
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
            onClick={makeToggleHandler(setDefaultFastMode, "default_fast_mode")}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>
    </div>
  );
}
