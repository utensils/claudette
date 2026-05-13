import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/useAppStore";
import {
  getAppSetting,
  listAgentBackends,
  listAppSettingsWithPrefix,
  resetAgentSession,
  setAppSetting,
} from "../../../services/tauri";
import { planAlternativeBackendDisableCleanup } from "../alternativeBackendCleanup";
import {
  planCodexBackendGateMigration,
  shouldEnableAlternativeBackendsForCodex,
} from "../codexBackendMigration";
import styles from "../Settings.module.css";

export function ExperimentalSettings() {
  const { t } = useTranslation("settings");
  const claudetteTerminalEnabled = useAppStore(
    (s) => s.claudetteTerminalEnabled,
  );
  const setClaudetteTerminalEnabled = useAppStore(
    (s) => s.setClaudetteTerminalEnabled,
  );
  const usageInsightsEnabled = useAppStore((s) => s.usageInsightsEnabled);
  const setUsageInsightsEnabled = useAppStore((s) => s.setUsageInsightsEnabled);
  const pluginManagementEnabled = useAppStore((s) => s.pluginManagementEnabled);
  const setPluginManagementEnabled = useAppStore((s) => s.setPluginManagementEnabled);
  const claudeRemoteControlEnabled = useAppStore(
    (s) => s.claudeRemoteControlEnabled,
  );
  const setClaudeRemoteControlEnabled = useAppStore(
    (s) => s.setClaudeRemoteControlEnabled,
  );
  const communityRegistryEnabled = useAppStore(
    (s) => s.communityRegistryEnabled,
  );
  const setCommunityRegistryEnabled = useAppStore(
    (s) => s.setCommunityRegistryEnabled,
  );
  const alternativeBackendsEnabled = useAppStore(
    (s) => s.alternativeBackendsEnabled,
  );
  const alternativeBackendsAvailable = useAppStore(
    (s) => s.alternativeBackendsAvailable,
  );
  const setAlternativeBackendsEnabled = useAppStore(
    (s) => s.setAlternativeBackendsEnabled,
  );
  const experimentalCodexEnabled = useAppStore(
    (s) => s.experimentalCodexEnabled,
  );
  const setExperimentalCodexEnabled = useAppStore(
    (s) => s.setExperimentalCodexEnabled,
  );
  const setAgentBackends = useAppStore((s) => s.setAgentBackends);
  const setDefaultAgentBackendId = useAppStore(
    (s) => s.setDefaultAgentBackendId,
  );
  const [error, setError] = useState<string | null>(null);

  const handleClaudetteTerminalToggle = async () => {
    const next = !claudetteTerminalEnabled;
    setClaudetteTerminalEnabled(next);
    try {
      setError(null);
      await setAppSetting("claudette_terminal_enabled", next ? "true" : "false");
    } catch (e) {
      setClaudetteTerminalEnabled(!next);
      setError(String(e));
    }
  };

  const handleUsageToggle = async () => {
    const next = !usageInsightsEnabled;
    setUsageInsightsEnabled(next);
    try {
      setError(null);
      await setAppSetting("usage_insights_enabled", next ? "true" : "false");
    } catch (e) {
      setUsageInsightsEnabled(!next);
      setError(String(e));
    }
  };

  const handlePluginManagementToggle = async () => {
    const next = !pluginManagementEnabled;
    setPluginManagementEnabled(next);
    try {
      setError(null);
      await setAppSetting("plugin_management_enabled", next ? "true" : "false");
    } catch (e) {
      setPluginManagementEnabled(!next);
      setError(String(e));
    }
  };

  const handleClaudeRemoteControlToggle = async () => {
    const next = !claudeRemoteControlEnabled;
    setClaudeRemoteControlEnabled(next);
    try {
      setError(null);
      await setAppSetting("claude_remote_control_enabled", next ? "true" : "false");
    } catch (e) {
      setClaudeRemoteControlEnabled(!next);
      setError(String(e));
    }
  };

  const handleCommunityRegistryToggle = async () => {
    const next = !communityRegistryEnabled;
    setCommunityRegistryEnabled(next);
    try {
      setError(null);
      await setAppSetting(
        "community_registry_enabled",
        next ? "true" : "false",
      );
    } catch (e) {
      setCommunityRegistryEnabled(!next);
      setError(String(e));
    }
  };

  const resetAlternativeBackendSelections = async () => {
    const [
      defaultModel,
      defaultBackend,
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
      defaultModel,
      defaultBackend,
      sessionModels,
      sessionProviders,
      selectedModels: store.selectedModel,
      selectedProviders: store.selectedModelProvider,
    });

    if (plan.resetDefault) {
      await setAppSetting("default_model", plan.defaultModel);
      await setAppSetting("default_agent_backend", plan.defaultBackend);
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
    const previousCodex = experimentalCodexEnabled;
    setAlternativeBackendsEnabled(next);
    if (!next && experimentalCodexEnabled) {
      setExperimentalCodexEnabled(false);
    }
    try {
      setError(null);
      if (!next) {
        if (experimentalCodexEnabled) {
          await migrateExperimentalCodexSelections(false);
          await setAppSetting("experimental_codex_enabled", "false");
        }
        await resetAlternativeBackendSelections();
      }
      await setAppSetting("alternative_backends_enabled", next ? "true" : "false");
    } catch (e) {
      setAlternativeBackendsEnabled(previous);
      setExperimentalCodexEnabled(previousCodex);
      setError(String(e));
    }
  };

  const migrateExperimentalCodexSelections = async (enableNative: boolean) => {
    const [
      defaultBackend,
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
      defaultBackend,
      sessionProviders,
      selectedProviders: store.selectedModelProvider,
    });

    if (plan.resetDefault && plan.defaultBackend) {
      await setAppSetting("default_agent_backend", plan.defaultBackend);
      setDefaultAgentBackendId(plan.defaultBackend);
    }

    const persistedModels = new Map<string, string>();
    for (const [key, value] of sessionModels) {
      if (key.startsWith("model:")) {
        persistedModels.set(key.slice("model:".length), value);
      }
    }

    for (const sessionId of plan.sessionIds) {
      const model = persistedModels.get(sessionId) ?? store.selectedModel[sessionId];
      if (model) {
        store.setSelectedModel(sessionId, model, plan.toBackend);
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

  const handleExperimentalCodexToggle = async () => {
    if (!alternativeBackendsAvailable) return;
    const next = !experimentalCodexEnabled;
    const previous = experimentalCodexEnabled;
    const shouldEnableAlternativeBackends = shouldEnableAlternativeBackendsForCodex(
      next,
      alternativeBackendsEnabled,
    );
    setExperimentalCodexEnabled(next);
    if (shouldEnableAlternativeBackends) {
      setAlternativeBackendsEnabled(true);
    }
    try {
      setError(null);
      if (shouldEnableAlternativeBackends) {
        await setAppSetting("alternative_backends_enabled", "true");
      }
      await migrateExperimentalCodexSelections(next);
      await setAppSetting("experimental_codex_enabled", next ? "true" : "false");
      const data = await listAgentBackends();
      setAgentBackends(data.backends);
      setDefaultAgentBackendId(data.default_backend_id);
    } catch (e) {
      setExperimentalCodexEnabled(previous);
      if (shouldEnableAlternativeBackends) {
        setAlternativeBackendsEnabled(false);
      }
      setError(String(e));
    }
  };

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("experimental_title")}</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>
            {t("experimental_claudette_terminal")}
          </div>
          <div className={styles.settingDescription}>
            {t("experimental_claudette_terminal_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={claudetteTerminalEnabled}
            aria-label={t("experimental_claudette_terminal_aria")}
            data-checked={claudetteTerminalEnabled}
            onClick={handleClaudetteTerminalToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>
            {t("experimental_alternative_backends")}
          </div>
          <div className={styles.settingDescription}>
            {t("experimental_alternative_backends_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={alternativeBackendsEnabled}
            aria-label={t("experimental_alternative_backends_aria")}
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
            {t("experimental_codex")}
          </div>
          <div className={styles.settingDescription}>
            {t("experimental_codex_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={experimentalCodexEnabled}
            aria-label={t("experimental_codex_aria")}
            data-checked={experimentalCodexEnabled}
            disabled={!alternativeBackendsAvailable}
            onClick={handleExperimentalCodexToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("experimental_plugin_mgmt")}</div>
          <div className={styles.settingDescription}>
            {t("experimental_plugin_mgmt_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={pluginManagementEnabled}
            aria-label={t("experimental_plugin_mgmt_aria")}
            data-checked={pluginManagementEnabled}
            onClick={handlePluginManagementToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>
            {t("experimental_claude_remote_control")}
          </div>
          <div className={styles.settingDescription}>
            {t("experimental_claude_remote_control_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={claudeRemoteControlEnabled}
            aria-label={t("experimental_claude_remote_control_aria")}
            data-checked={claudeRemoteControlEnabled}
            onClick={handleClaudeRemoteControlToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>
            {t("experimental_community_registry")}
          </div>
          <div className={styles.settingDescription}>
            {t("experimental_community_registry_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={communityRegistryEnabled}
            aria-label={t("experimental_community_registry_aria")}
            data-checked={communityRegistryEnabled}
            onClick={handleCommunityRegistryToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("experimental_usage")}</div>
          <div className={styles.settingDescription}>
            {t("experimental_usage_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={usageInsightsEnabled}
            aria-label={t("experimental_usage_aria")}
            data-checked={usageInsightsEnabled}
            onClick={handleUsageToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>
    </div>
  );
}
