import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAppSetting, setAppSetting, listAgentBackends, saveAgentBackend, saveAgentBackendSecret, refreshAgentBackendModels, testAgentBackend, launchCodexLogin } from "../../../services/tauri";
import type { AgentBackendConfig } from "../../../services/tauri";
import { EFFORT_LEVELS } from "../../chat/EffortSelector";
import { isFastSupported, isEffortSupported, isXhighEffortAllowed, isMaxEffortAllowed } from "../../chat/modelCapabilities";
import { buildModelRegistry, resolveModelSelection } from "../../chat/modelRegistry";
import { useAppStore } from "../../../stores/useAppStore";
import styles from "../Settings.module.css";

export function ModelSettings() {
  const { t } = useTranslation("settings");
  const [defaultModel, setDefaultModel] = useState("opus");
  const [defaultBackend, setDefaultBackend] = useState("anthropic");
  const [defaultThinking, setDefaultThinking] = useState(false);
  const [defaultPlanMode, setDefaultPlanMode] = useState(false);
  const [defaultFastMode, setDefaultFastMode] = useState(false);
  const [defaultChrome, setDefaultChrome] = useState(false);
  const [defaultEffort, setDefaultEffort] = useState("auto");
  const [defaultShowThinking, setDefaultShowThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alternativeBackendsEnabled = useAppStore((s) => s.alternativeBackendsEnabled);
  const agentBackends = useAppStore((s) => s.agentBackends);
  const setAgentBackends = useAppStore((s) => s.setAgentBackends);
  const setDefaultAgentBackendId = useAppStore((s) => s.setDefaultAgentBackendId);

  useEffect(() => {
    getAppSetting("default_model")
      .then((val) => { if (val) setDefaultModel(val); })
      .catch(() => {});
    getAppSetting("default_agent_backend")
      .then((val) => {
        if (val) {
          setDefaultBackend(val);
          setDefaultAgentBackendId(val);
        }
      })
      .catch(() => {});
    listAgentBackends()
      .then((data) => {
        setAgentBackends(data.backends);
        setDefaultBackend(data.default_backend_id);
        setDefaultAgentBackendId(data.default_backend_id);
      })
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
  }, [setAgentBackends, setDefaultAgentBackendId]);

  const saveSetting = async (key: string, value: string) => {
    try {
      setError(null);
      await setAppSetting(key, value);
    } catch (e) {
      setError(String(e));
    }
  };

  const registry = buildModelRegistry(alternativeBackendsEnabled, agentBackends);
  const defaultModelValue = `${defaultBackend}/${defaultModel}`;

  const handleModelChange = async (value: string) => {
    const [backendId, ...modelParts] = value.includes("/")
      ? value.split("/")
      : ["anthropic", value];
    const model = modelParts.join("/");
    const match = resolveModelSelection(registry, backendId === "anthropic" ? model : value);
    const nextBackend = match?.providerId ?? backendId;
    setDefaultModel(model);
    setDefaultBackend(nextBackend);
    setDefaultAgentBackendId(nextBackend);
    await saveSetting("default_model", model);
    await saveSetting("default_agent_backend", nextBackend);
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
  const selectedDefaultModel = registry.find(
    (m) => (m.providerId ?? "anthropic") === defaultBackend && m.id === defaultModel,
  );
  const supportsEffort = selectedDefaultModel?.supportsEffort ?? isEffortSupported(defaultModel);
  const supportsFast = selectedDefaultModel?.supportsFastMode ?? isFastSupported(defaultModel);
  const availableEffortLevels = isXhighEffortAllowed(defaultModel)
    ? EFFORT_LEVELS
    : isMaxEffortAllowed(defaultModel)
      ? EFFORT_LEVELS.filter((l) => l.id !== "xhigh")
      : EFFORT_LEVELS.filter((l) => l.id !== "xhigh" && l.id !== "max");
  const effortDisabled = !supportsEffort;
  const fastDisabled = !supportsFast;

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
              value={defaultModelValue}
              onChange={(e) => handleModelChange(e.target.value)}
            >
              {registry.map((m) => (
                <option key={m.providerQualifiedId ?? `anthropic/${m.id}`} value={m.providerQualifiedId ?? `anthropic/${m.id}`}>
                  {m.providerLabel ? `${m.providerLabel} / ${m.label}` : m.label}
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

      <BackendSettingsPanel
        enabled={alternativeBackendsEnabled}
        backends={agentBackends}
        onBackends={setAgentBackends}
        setError={setError}
      />
    </div>
  );
}

function BackendSettingsPanel({
  enabled,
  backends,
  onBackends,
  setError,
}: {
  enabled: boolean;
  backends: AgentBackendConfig[];
  onBackends: (backends: AgentBackendConfig[]) => void;
  setError: (error: string | null) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div>
      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("models_backends_title")}</div>
          <div className={styles.settingDescription}>
            {enabled ? t("models_backends_desc") : t("models_backends_disabled")}
          </div>
        </div>
      </div>
      {backends.filter((b) => b.id !== "anthropic").map((backend) => (
        <BackendCard
          key={backend.id}
          backend={backend}
          onSaved={onBackends}
          setError={setError}
        />
      ))}
    </div>
  );
}

function BackendCard({
  backend,
  onSaved,
  setError,
}: {
  backend: AgentBackendConfig;
  onSaved: (backends: AgentBackendConfig[]) => void;
  setError: (error: string | null) => void;
}) {
  const { t } = useTranslation("settings");
  const [draft, setDraft] = useState(backend);
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [statusModelCount, setStatusModelCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(backend);
    setSecret("");
    setStatus(null);
    setStatusModelCount(null);
    setBusy(false);
  }, [backend]);

  const discoveredModels = dedupeBackendModels(draft.discovered_models);
  const manualModels = dedupeBackendModels(draft.manual_models);
  const modelOptions = dedupeBackendModels([...discoveredModels, ...manualModels]);
  const manualModelText = manualModels.map((m) => m.id).join(", ");
  const discoveryBackend = isDiscoveryBackend(draft);
  const showBaseUrl = draft.kind !== "codex_subscription";
  const showSecret = draft.kind !== "codex_subscription";
  const showManualModels = draft.kind === "custom_anthropic" || draft.kind === "custom_openai";
  const actualModelCount = countBackendModels(draft);
  const displayModelCount = actualModelCount > 0 ? actualModelCount : statusModelCount ?? 0;
  const selectedDefaultModel = modelOptions.some((model) => model.id === draft.default_model)
    ? draft.default_model ?? ""
    : "";

  const applySavedBackends = (saved: AgentBackendConfig[]) => {
    onSaved(saved);
    const refreshed = saved.find((item) => item.id === draft.id);
    if (refreshed) {
      setDraft(refreshed);
    }
    return refreshed;
  };

  const persistDraft = async () => {
    if (secret) {
      await saveAgentBackendSecret({ backend_id: draft.id, value: secret });
    }
    const saved = await saveAgentBackend(draft);
    onSaved(saved);
    setSecret("");
    return saved;
  };

  const save = async () => {
    try {
      setError(null);
      setBusy(true);
      await persistDraft();
      setStatusModelCount(null);
      setStatus(t("models_backend_status_saved"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    try {
      setError(null);
      setBusy(true);
      await persistDraft();
      const saved = await refreshAgentBackendModels(draft.id);
      const refreshed = applySavedBackends(saved);
      const count = (refreshed?.discovered_models.length ?? 0) + (refreshed?.manual_models.length ?? 0);
      setStatusModelCount(count);
      setStatus(t("models_backend_status_refreshed", { count }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    try {
      setError(null);
      setBusy(true);
      await persistDraft();
      const result = await testAgentBackend(draft.id);
      let refreshed: AgentBackendConfig | undefined;
      if (result.backends) {
        refreshed = applySavedBackends(result.backends);
      } else if (result.ok && discoveryBackend) {
        const saved = await refreshAgentBackendModels(draft.id);
        refreshed = applySavedBackends(saved);
      }
      const count = refreshed ? countBackendModels(refreshed) : parseModelCount(result.message);
      setStatusModelCount(count);
      setStatus(result.message);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const updateModels = (value: string) => {
    setDraft({
      ...draft,
      manual_models: value
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
        .map((id) => ({
          id,
          label: id,
          context_window_tokens: draft.context_window_default,
          discovered: false,
        })),
    });
  };

  return (
    <div className={styles.settingRow}>
      <div className={styles.settingInfo}>
        <div className={styles.settingLabel}>{draft.label}</div>
        <div className={styles.settingDescription}>
          {draft.kind} · {displayModelCount} models
          {status ? ` · ${status}` : ""}
        </div>
        <div className={styles.backendForm}>
          {showBaseUrl && (
            <label className={styles.backendField}>
              <span className={styles.backendFieldLabel}>{t("models_backend_base_url")}</span>
              <input
                className={styles.input}
                value={draft.base_url ?? ""}
                placeholder={t("models_backend_base_url")}
                onChange={(e) => setDraft({ ...draft, base_url: e.target.value || null })}
              />
            </label>
          )}
          <label className={styles.backendField}>
            <span className={styles.backendFieldLabel}>{t("models_backend_default_model")}</span>
            {discoveryBackend || modelOptions.length > 0 ? (
              <select
                className={styles.select}
                value={selectedDefaultModel}
                onChange={(e) => setDraft({ ...draft, default_model: e.target.value || null })}
              >
                <option value="">{t("models_backend_default_auto")}</option>
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label || model.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={styles.input}
                value={draft.default_model ?? ""}
                placeholder={t("models_backend_default_model")}
                onChange={(e) => setDraft({ ...draft, default_model: e.target.value || null })}
              />
            )}
          </label>
        </div>
        <div className={styles.backendForm}>
          {discoveryBackend && (
            <label className={styles.backendField}>
              <span className={styles.backendFieldLabel}>{t("models_backend_discovered_models")}</span>
              <div className={styles.modelChipList}>
                {discoveredModels.length > 0 ? (
                  discoveredModels.map((model) => (
                    <span key={model.id} className={styles.modelChip}>{model.label || model.id}</span>
                  ))
                ) : (
                  <span className={styles.modelChipEmpty}>{t("models_backend_no_discovered_models")}</span>
                )}
              </div>
            </label>
          )}
          {showManualModels && (
            <label className={styles.backendField}>
              <span className={styles.backendFieldLabel}>{t("models_backend_manual_models")}</span>
              <input
                className={styles.input}
                value={manualModelText}
                placeholder={t("models_backend_manual_models_placeholder")}
                onChange={(e) => updateModels(e.target.value)}
              />
            </label>
          )}
          {showSecret && (
            <label className={styles.backendField}>
              <span className={styles.backendFieldLabel}>{t("models_backend_secret")}</span>
              <input
                className={styles.input}
                type="password"
                value={secret}
                placeholder={draft.has_secret ? t("models_backend_secret_saved") : t("models_backend_secret")}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
          )}
        </div>
      </div>
      <div className={styles.settingControl}>
        <div className={styles.backendActions}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={draft.enabled}
            aria-label={t("models_backend_enabled")}
            data-checked={draft.enabled}
            onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
          >
            <div className={styles.toggleKnob} />
          </button>
          <button className={styles.iconBtn} onClick={save} disabled={busy}>{t("models_backend_save")}</button>
          <button className={styles.iconBtn} onClick={test} disabled={busy}>{t("models_backend_test")}</button>
          {discoveryBackend && (
            <button className={styles.iconBtn} onClick={refresh} disabled={busy}>{t("models_backend_refresh")}</button>
          )}
          {draft.kind === "codex_subscription" && (
            <button className={styles.iconBtn} onClick={() => void launchCodexLogin()} disabled={busy}>
              {t("models_backend_login")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function dedupeBackendModels(models: AgentBackendConfig["manual_models"]) {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function countBackendModels(backend: AgentBackendConfig) {
  return dedupeBackendModels([...backend.discovered_models, ...backend.manual_models]).length;
}

function parseModelCount(message: string) {
  const match = message.match(/Found\s+(\d+)\s+model/i);
  return match ? Number(match[1]) : null;
}

function isDiscoveryBackend(backend: AgentBackendConfig) {
  return (
    backend.model_discovery ||
    backend.kind === "ollama" ||
    backend.kind === "openai_api" ||
    backend.kind === "codex_subscription"
  );
}
