import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import {
  deleteAppSetting,
  getAppSetting,
  launchCodexLogin,
  listAgentBackends,
  listAppSettingsWithPrefix,
  refreshAgentBackendModels,
  resetAgentSession,
  saveAgentBackend,
  saveAgentBackendSecret,
  setAppSetting,
  testAgentBackend,
} from "../../../services/tauri";
import type { AgentBackendConfig } from "../../../services/tauri";
import { isFastSupported, isEffortSupported } from "../../chat/modelCapabilities";
import {
  getReasoningLevels,
  normalizeReasoningLevel,
  reasoningVariantForModel,
} from "../../chat/reasoningControls";
import {
  buildModelRegistry,
  groupPiDiscoveredModels,
  resolveModelSelection,
} from "../../chat/modelRegistry";
import { useAppStore } from "../../../stores/useAppStore";
import { formatBackendError } from "../backendSettingsErrors";
import { planAlternativeBackendDisableCleanup } from "../alternativeBackendCleanup";
import { SearchableSelect } from "../SearchableSelect";
import { RuntimeSelector } from "../RuntimeSelector";
import {
  LEGACY_CODEX_BACKEND,
  LEGACY_NATIVE_CODEX_BACKEND,
  NATIVE_CODEX_BACKEND,
  planCodexBackendGateMigration,
  resolveCodexBackendMigrationModel,
} from "../codexBackendMigration";
import { shouldShowBackendTestButton } from "../agentBackendStartupRefresh";
import { ClaudeCodeAuthSetting } from "../../auth/ClaudeCodeAuthSetting";
import styles from "../Settings.module.css";

const BACKEND_AUTO_DETECT_DISABLED_PREFIX = "agent_backend_auto_detect_disabled:";

function autoDetectDisabledKey(backendId: string) {
  return `${BACKEND_AUTO_DETECT_DISABLED_PREFIX}${backendId}`;
}

function normalizeBackendId(backendId: string) {
  return backendId === LEGACY_CODEX_BACKEND || backendId === LEGACY_NATIVE_CODEX_BACKEND
    ? NATIVE_CODEX_BACKEND
    : backendId;
}

export function ModelSettings() {
  const { t } = useTranslation("settings");
  const [defaultModel, setDefaultModel] = useState("opus");
  const [defaultBackend, setDefaultBackend] = useState("anthropic");
  const [defaultThinking, setDefaultThinking] = useState(false);
  const [defaultPlanMode, setDefaultPlanMode] = useState(false);
  const [defaultFastMode, setDefaultFastMode] = useState(false);
  const [defaultChrome, setDefaultChrome] = useState(false);
  const [teamAgentSessionTabs, setTeamAgentSessionTabs] = useState(true);
  const [defaultEffort, setDefaultEffort] = useState("auto");
  const [defaultShowThinking, setDefaultShowThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tolerant-loader diagnostics: non-fatal warnings emitted when
  // stored backend entries can't be parsed by this build (e.g. a
  // newer dev build wrote `lm_studio` and we're an older build).
  // Backend keeps the entries as opaque passthrough; user just needs
  // to know they aren't active in this session.
  const [backendWarnings, setBackendWarnings] = useState<string[]>([]);
  const alternativeBackendsEnabled = useAppStore((s) => s.alternativeBackendsEnabled);
  const alternativeBackendsAvailable = useAppStore((s) => s.alternativeBackendsAvailable);
  const setAlternativeBackendsEnabled = useAppStore((s) => s.setAlternativeBackendsEnabled);
  const codexEnabled = useAppStore((s) => s.codexEnabled);
  const setCodexEnabled = useAppStore((s) => s.setCodexEnabled);
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
          const backendId = normalizeBackendId(val);
          setDefaultBackend(backendId);
          setDefaultAgentBackendId(backendId);
        }
      })
      .catch(() => {});
    listAgentBackends()
      .then((data) => {
        setAgentBackends(data.backends);
        setDefaultBackend(data.default_backend_id);
        setDefaultAgentBackendId(data.default_backend_id);
        setBackendWarnings(data.warnings ?? []);
      })
      .catch((e) => {
        // No longer silent: previously a `.catch(() => {})` here meant
        // a backend-settings parse failure left the Models panel
        // empty with zero diagnostics. The Rust loader is now
        // tolerant per-entry, so reaching this catch implies a
        // genuinely unrecoverable failure (DB open, top-level
        // command error). Surface it so the user can act.
        setError(`Failed to load agent backends: ${String(e)}`);
      });
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
    getAppSetting("team_agent_session_tabs_enabled")
      .then((val) => setTeamAgentSessionTabs(val !== "false"))
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

  const registry = useMemo(
    () => buildModelRegistry(alternativeBackendsEnabled, agentBackends, codexEnabled),
    [alternativeBackendsEnabled, agentBackends, codexEnabled],
  );
  const visibleBackends = useMemo(
    () =>
      agentBackends.filter((backend) => {
        if (backend.id === "anthropic" || backend.kind === "codex_subscription") return false;
        if (backend.kind === "codex_native") return codexEnabled;
        if (backend.kind === "pi_sdk") return true;
        return alternativeBackendsEnabled;
      }),
    [agentBackends, alternativeBackendsEnabled, codexEnabled],
  );
  const anthropicBackend = useMemo(
    () => agentBackends.find((backend) => backend.id === "anthropic") ?? null,
    [agentBackends],
  );
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
    if (defaultFastMode && !(match?.supportsFastMode ?? isFastSupported(model))) {
      setDefaultFastMode(false);
      await saveSetting("default_fast_mode", "false");
    }
    // Normalize effort when model changes
    if (!(match?.supportsEffort ?? isEffortSupported(model))) {
      setDefaultEffort("auto");
      await saveSetting("default_effort", "auto");
    } else {
      const normalized = normalizeReasoningLevel(
        defaultEffort,
        model,
        reasoningVariantForModel(match),
      );
      if (normalized !== defaultEffort) {
        setDefaultEffort(normalized);
        await saveSetting("default_effort", normalized);
      }
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

  const resetAlternativeBackendSelections = async () => {
    const [
      defaultModelSetting,
      defaultBackendSetting,
      sessionModels,
      sessionProviders,
    ] = await Promise.all([
      getAppSetting("default_model"),
      getAppSetting("default_agent_backend"),
      listAppSettingsWithPrefix("model:"),
      listAppSettingsWithPrefix("model_provider:"),
    ]);
    const store = useAppStore.getState();
    const plan = planAlternativeBackendDisableCleanup({
      defaultModel: defaultModelSetting,
      defaultBackend: defaultBackendSetting,
      sessionModels,
      sessionProviders,
      selectedModels: store.selectedModel,
      selectedProviders: store.selectedModelProvider,
    });

    if (plan.resetDefault) {
      await setAppSetting("default_model", plan.defaultModel);
      await setAppSetting("default_agent_backend", plan.defaultBackend);
      setDefaultModel(plan.defaultModel);
      setDefaultBackend(plan.defaultBackend);
      setDefaultAgentBackendId(plan.defaultBackend);
    }

    for (const sessionId of plan.sessionIds) {
      store.setSelectedModel(sessionId, plan.defaultModel, plan.defaultBackend);
      await setAppSetting(`model:${sessionId}`, plan.defaultModel);
      await setAppSetting(`model_provider:${sessionId}`, plan.defaultBackend);
      await resetAgentSession(sessionId);
      store.clearAgentQuestion(sessionId);
      store.clearPlanApproval(sessionId);
      store.clearAgentApproval(sessionId);
    }
  };

  const handleAlternativeBackendsToggle = async () => {
    if (!alternativeBackendsAvailable) return;
    const next = !alternativeBackendsEnabled;
    const previous = alternativeBackendsEnabled;
    setAlternativeBackendsEnabled(next);
    try {
      setError(null);
      if (!next) {
        await resetAlternativeBackendSelections();
      }
      await setAppSetting("alternative_backends_enabled", next ? "true" : "false");
    } catch (e) {
      setAlternativeBackendsEnabled(previous);
      setError(String(e));
    }
  };

  const migrateCodexSelections = async (
    enableNative: boolean,
    backends: readonly AgentBackendConfig[],
  ) => {
    const [
      defaultBackendSetting,
      sessionModels,
      sessionProviders,
    ] = await Promise.all([
      getAppSetting("default_agent_backend"),
      listAppSettingsWithPrefix("model:"),
      listAppSettingsWithPrefix("model_provider:"),
    ]);
    const store = useAppStore.getState();
    const plan = planCodexBackendGateMigration({
      enableNative,
      defaultBackend: defaultBackendSetting,
      sessionProviders,
      selectedProviders: store.selectedModelProvider,
    });

    if (plan.resetDefault && plan.defaultBackend) {
      await setAppSetting("default_agent_backend", plan.defaultBackend);
      if (plan.toModel) {
        await setAppSetting("default_model", plan.toModel);
        setDefaultModel(plan.toModel);
      }
      setDefaultBackend(plan.defaultBackend);
      setDefaultAgentBackendId(plan.defaultBackend);
    }

    const persistedModels = new Map<string, string>();
    for (const [key, value] of sessionModels) {
      if (key.startsWith("model:")) {
        persistedModels.set(key.slice("model:".length), value);
      }
    }

    for (const sessionId of plan.sessionIds) {
      const model = resolveCodexBackendMigrationModel({
        plan,
        sessionId,
        persistedModels,
        selectedModels: store.selectedModel,
        backends,
      });
      if (model) {
        store.setSelectedModel(sessionId, model, plan.toBackend);
        await setAppSetting(`model:${sessionId}`, model);
      } else {
        store.setSelectedModelProvider(sessionId, plan.toBackend);
      }
      await setAppSetting(`model_provider:${sessionId}`, plan.toBackend);
      await resetAgentSession(sessionId);
      store.clearAgentQuestion(sessionId);
      store.clearPlanApproval(sessionId);
      store.clearAgentApproval(sessionId);
    }
  };

  const handleCodexToggle = async () => {
    if (!alternativeBackendsAvailable) return;
    const next = !codexEnabled;
    const previous = codexEnabled;
    let persistedToggle = false;
    setCodexEnabled(next);
    try {
      setError(null);
      await setAppSetting("codex_enabled", next ? "true" : "false");
      if (next) {
        await deleteAppSetting(autoDetectDisabledKey(NATIVE_CODEX_BACKEND));
      } else {
        await setAppSetting(autoDetectDisabledKey(NATIVE_CODEX_BACKEND), "true");
      }
      persistedToggle = true;
      const data = await listAgentBackends();
      setAgentBackends(data.backends);
      setDefaultBackend(data.default_backend_id);
      setDefaultAgentBackendId(data.default_backend_id);
      await migrateCodexSelections(next, data.backends);
    } catch (e) {
      setCodexEnabled(persistedToggle ? next : previous);
      setError(String(e));
    }
  };

  // Filter effort levels based on selected default model
  const selectedDefaultModel = registry.find(
    (m) => (m.providerId ?? "anthropic") === defaultBackend && m.id === defaultModel,
  );
  const reasoningVariant = reasoningVariantForModel(selectedDefaultModel);
  const isCodex = reasoningVariant === "codex";
  const supportsEffort = selectedDefaultModel?.supportsEffort ?? isEffortSupported(defaultModel);
  const supportsFast = selectedDefaultModel?.supportsFastMode ?? isFastSupported(defaultModel);
  const availableEffortLevels = getReasoningLevels(defaultModel, reasoningVariant);
  const selectedEffort = normalizeReasoningLevel(
    defaultEffort,
    defaultModel,
    reasoningVariant,
  );
  const effortDisabled = !supportsEffort;
  const fastDisabled = !supportsFast;

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("models_title")}</h2>

      {error && <div className={styles.error}>{error}</div>}

      {backendWarnings.length > 0 && (
        <div className={styles.backendWarningBanner} role="status" aria-live="polite">
          <div className={styles.backendWarningTitle}>
            {t("models_backend_warnings_title", "Some saved backend entries weren't loaded")}
          </div>
          <ul className={styles.backendWarningList}>
            {backendWarnings.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
          <div className={styles.backendWarningHint}>
            {t(
              "models_backend_warnings_hint",
              "These entries are preserved in your settings and will reactivate on a build that supports them.",
            )}
          </div>
        </div>
      )}

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("models_default_model")}</div>
          <div className={styles.settingDescription}>
            {t("models_default_model_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.inlineControl}>
            <div className={styles.defaultModelPickerWrapper}>
              <SearchableSelect
                options={registry.map((m) => ({
                  value: m.providerQualifiedId ?? `anthropic/${m.id}`,
                  label: m.providerLabel ? `${m.providerLabel} / ${m.label}` : m.label,
                }))}
                value={defaultModelValue}
                onChange={handleModelChange}
                ariaLabel={t("models_default_model")}
              />
            </div>
            {!isCodex && (
              <select
                className={`${styles.select} ${styles.selectWide}`}
                value={defaultThinking ? "true" : "false"}
                onChange={(e) => handleThinkingChange(e.target.value)}
              >
                <option value="false">{t("models_thinking_off")}</option>
                <option value="true">{t("models_thinking_on")}</option>
              </select>
            )}
          </div>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>
            {isCodex ? t("models_default_codex_reasoning_effort") : t("models_default_effort")}
          </div>
          <div className={styles.settingDescription}>
            {isCodex ? t("models_default_codex_reasoning_effort_desc") : t("models_default_effort_desc")}
            {effortDisabled && t("models_effort_not_supported")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            className={`${styles.select}${effortDisabled ? ` ${styles.selectDim}` : ""}`}
            value={selectedEffort}
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
          <div className={styles.settingLabel}>
            {isCodex ? t("models_show_codex_reasoning") : t("models_show_thinking")}
          </div>
          <div className={styles.settingDescription}>
            {isCodex ? t("models_show_codex_reasoning_desc") : t("models_show_thinking_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={defaultShowThinking}
            aria-label={isCodex ? t("models_show_codex_reasoning") : t("models_show_thinking")}
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
          <div className={styles.settingLabel}>{t("models_team_agent_session_tabs")}</div>
          <div className={styles.settingDescription}>
            {t("models_team_agent_session_tabs_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={teamAgentSessionTabs}
            aria-label={t("models_team_agent_session_tabs")}
            data-checked={teamAgentSessionTabs}
            onClick={handleToggle(
              teamAgentSessionTabs,
              setTeamAgentSessionTabs,
              "team_agent_session_tabs_enabled",
            )}
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

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>
            {t("models_alternative_backends")}
          </div>
          <div className={styles.settingDescription}>
            {t(
              alternativeBackendsAvailable
                ? "models_alternative_backends_desc"
                : "models_alternative_backends_unavailable_desc",
            )}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={alternativeBackendsEnabled}
            aria-label={t("models_alternative_backends_aria")}
            data-checked={alternativeBackendsEnabled}
            disabled={!alternativeBackendsAvailable}
            onClick={handleAlternativeBackendsToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>
            {t("models_codex")}
          </div>
          <div className={styles.settingDescription}>
            {t(
              alternativeBackendsAvailable
                ? "models_codex_desc"
                : "models_codex_unavailable_desc",
            )}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={codexEnabled}
            aria-label={t("models_codex_aria")}
            data-checked={codexEnabled}
            disabled={!alternativeBackendsAvailable}
            onClick={handleCodexToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      {(anthropicBackend || visibleBackends.length > 0) && (
        <BackendSettingsPanel
          anthropicBackend={anthropicBackend}
          backends={visibleBackends}
          onBackends={setAgentBackends}
        />
      )}
    </div>
  );
}

function BackendSettingsPanel({
  anthropicBackend,
  backends,
  onBackends,
}: {
  anthropicBackend: AgentBackendConfig | null;
  backends: AgentBackendConfig[];
  onBackends: (backends: AgentBackendConfig[]) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div>
      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("models_backends_title")}</div>
          <div className={styles.settingDescription}>
            {t("models_backends_desc")}
          </div>
        </div>
      </div>
      {anthropicBackend && <ClaudeCodeAuthSetting />}
      {backends.filter((b) => b.id !== "anthropic").map((backend) => (
        <BackendCard
          key={backend.id}
          backend={backend}
          onSaved={onBackends}
        />
      ))}
    </div>
  );
}

function BackendCard({
  backend,
  onSaved,
}: {
  backend: AgentBackendConfig;
  onSaved: (backends: AgentBackendConfig[]) => void;
}) {
  const { t } = useTranslation("settings");
  const [draft, setDraft] = useState(backend);
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [statusModelCount, setStatusModelCount] = useState<number | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const lastSavedDraftRef = useRef("");
  const draftSaveSeqRef = useRef(0);
  const secretSaveSeqRef = useRef(0);

  useEffect(() => {
    lastSavedDraftRef.current = JSON.stringify(backend);
    setDraft(backend);
    setSecret("");
    setStatus(null);
    setStatusModelCount(null);
    setCardError(null);
    setBusy(false);
    setSaving(false);
  }, [backend]);

  const discoveredModels = dedupeBackendModels(draft.discovered_models);
  const manualModels = dedupeBackendModels(draft.manual_models);
  const modelOptions = dedupeBackendModels([...discoveredModels, ...manualModels]);
  const manualModelText = manualModels.map((m) => m.id).join(", ");
  const discoveryBackend = isDiscoveryBackend(draft);
  const usesCodexCliAuth = draft.kind === "codex_subscription" || draft.kind === "codex_native";
  const usesPiAuth = draft.kind === "pi_sdk";
  const showBaseUrl = !usesCodexCliAuth && !usesPiAuth;
  const showSecret = !usesCodexCliAuth && !usesPiAuth;
  const showManualModels = draft.kind === "custom_anthropic" || draft.kind === "custom_openai" || usesPiAuth;
  const showTestButton = shouldShowBackendTestButton(draft);
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

  const persistDraft = useCallback(async (nextDraft: AgentBackendConfig) => {
    const saved = await saveAgentBackend(nextDraft);
    onSaved(saved);
    const refreshed = saved.find((item) => item.id === nextDraft.id);
    lastSavedDraftRef.current = JSON.stringify(refreshed ?? nextDraft);
    return saved;
  }, [onSaved]);

  useEffect(() => {
    const serialized = JSON.stringify(draft);
    if (serialized === lastSavedDraftRef.current) return;
    const seq = draftSaveSeqRef.current + 1;
    draftSaveSeqRef.current = seq;
    setSaving(true);
    const handle = window.setTimeout(() => {
      void persistDraft(draft)
        .then(() => {
          if (draftSaveSeqRef.current !== seq) return;
          setStatusModelCount(null);
          setStatus(t("models_backend_status_saved"));
          setCardError(null);
        })
        .catch((e) => {
          if (draftSaveSeqRef.current !== seq) return;
          setCardError(formatBackendError(e, draft));
        })
        .finally(() => {
          if (draftSaveSeqRef.current === seq) setSaving(false);
        });
    }, 450);
    return () => window.clearTimeout(handle);
  }, [draft, persistDraft, t]);

  useEffect(() => {
    if (!secret) return;
    const seq = secretSaveSeqRef.current + 1;
    secretSaveSeqRef.current = seq;
    setSaving(true);
    const handle = window.setTimeout(() => {
      void saveAgentBackendSecret({ backend_id: draft.id, value: secret })
        .then(() => {
          if (secretSaveSeqRef.current !== seq) return;
          setSecret("");
          setStatus(t("models_backend_status_saved"));
          setCardError(null);
        })
        .catch((e) => {
          if (secretSaveSeqRef.current !== seq) return;
          setCardError(formatBackendError(e, draft));
        })
        .finally(() => {
          if (secretSaveSeqRef.current === seq) setSaving(false);
        });
    }, 650);
    return () => window.clearTimeout(handle);
  }, [draft, secret, t]);

  const persistCurrentDraft = async () => {
    if (secret) {
      await saveAgentBackendSecret({ backend_id: draft.id, value: secret });
      setSecret("");
    }
    return persistDraft(draft);
  };

  const refresh = async () => {
    try {
      setCardError(null);
      setBusy(true);
      await persistCurrentDraft();
      const saved = await refreshAgentBackendModels(draft.id);
      const refreshed = applySavedBackends(saved);
      const count = (refreshed?.discovered_models.length ?? 0) + (refreshed?.manual_models.length ?? 0);
      setStatusModelCount(count);
      setStatus(t("models_backend_status_refreshed", { count }));
    } catch (e) {
      setCardError(formatBackendError(e, draft));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    try {
      setCardError(null);
      setBusy(true);
      await persistCurrentDraft();
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
      setCardError(formatBackendError(e, draft));
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
          {saving ? ` · ${t("models_backend_status_saving")}` : ""}
          {status ? ` · ${status}` : ""}
        </div>
        {cardError && (
          <div className={styles.backendError} role="alert">
            {cardError}
          </div>
        )}
        <div className={styles.backendForm}>
          <RuntimeSelector
            backend={draft}
            onSaved={(saved) => {
              const refreshed = saved.find((item) => item.id === draft.id);
              if (refreshed) {
                lastSavedDraftRef.current = JSON.stringify(refreshed);
                setDraft(refreshed);
              }
              onSaved(saved);
            }}
            onError={(err) => setCardError(formatBackendError(err, draft))}
          />
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
              <SearchableSelect
                options={modelOptions.map((model) => ({
                  value: model.id,
                  label: model.label || model.id,
                }))}
                value={selectedDefaultModel}
                onChange={(next) =>
                  setDraft({ ...draft, default_model: next || null })
                }
                autoOption={{ value: "", label: t("models_backend_default_auto") }}
                ariaLabel={t("models_backend_default_model")}
              />
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
              {draft.kind === "pi_sdk" ? (
                <PiDiscoveredModelsList models={discoveredModels} />
              ) : (
                <div className={styles.modelChipList}>
                  {discoveredModels.length > 0 ? (
                    discoveredModels.map((model) => (
                      <span key={model.id} className={styles.modelChip}>{model.label || model.id}</span>
                    ))
                  ) : (
                    <span className={styles.modelChipEmpty}>{t("models_backend_no_discovered_models")}</span>
                  )}
                </div>
              )}
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
          {showTestButton && (
            <button className={styles.iconBtn} onClick={test} disabled={busy}>{t("models_backend_test")}</button>
          )}
          {discoveryBackend && (
            <button className={styles.iconBtn} onClick={refresh} disabled={busy}>{t("models_backend_refresh")}</button>
          )}
          {usesCodexCliAuth && (
            <button className={styles.iconBtn} onClick={() => void launchCodexLogin()} disabled={busy}>
              {t("models_backend_login")}
            </button>
          )}
          {usesPiAuth && (
            <button
              className={styles.iconBtn}
              onClick={() => setStatus(t("models_backend_pi_auth_guidance", "Run `pi auth` in a terminal, then refresh Pi models."))}
              disabled={busy}
            >
              {t("models_backend_pi_login")}
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
    backend.kind === "codex_native" ||
    backend.kind === "pi_sdk" ||
    backend.kind === "lm_studio"
  );
}

function PiDiscoveredModelsList({
  models,
}: {
  models: AgentBackendConfig["discovered_models"];
}) {
  const { t } = useTranslation("settings");
  const groups = useMemo(() => groupPiDiscoveredModels(models), [models]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  if (models.length === 0) {
    return (
      <div className={styles.modelChipList}>
        <span className={styles.modelChipEmpty}>
          {t("models_backend_no_discovered_models")}
        </span>
      </div>
    );
  }

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className={styles.piDiscoveredList}>
      <div className={styles.piDiscoveredSummary}>
        {t("models_backend_pi_discovered_summary", {
          providers: groups.length,
          models: models.length,
          defaultValue: "{{providers}} providers · {{models}} models",
        })}
      </div>
      {groups.map((group) => {
        const isOpen = expanded.has(group.key);
        return (
          <div key={group.key} className={styles.piDiscoveredGroup}>
            <button
              type="button"
              className={styles.piDiscoveredHeader}
              aria-expanded={isOpen}
              onClick={() => toggle(group.key)}
            >
              <ChevronRight
                size={12}
                className={`${styles.piDiscoveredChevron} ${isOpen ? styles.piDiscoveredChevronOpen : ""}`}
                aria-hidden
              />
              <span className={styles.piDiscoveredGroupLabel}>{group.label}</span>
              <span className={styles.piDiscoveredGroupCount}>
                {group.models.length}
              </span>
            </button>
            {isOpen && (
              <div className={styles.piDiscoveredChips}>
                {group.models.map((model) => (
                  <span key={model.id} className={styles.modelChip} title={model.id}>
                    {model.label || model.id}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
