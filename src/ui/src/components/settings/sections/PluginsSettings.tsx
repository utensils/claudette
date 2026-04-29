import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../../stores/useAppStore";
import {
  listBuiltinClaudettePlugins,
  listClaudettePlugins,
  reseedBundledPlugins,
  setBuiltinClaudettePluginEnabled,
  setClaudettePluginEnabled,
  setClaudettePluginSetting,
  type BuiltinPluginInfo,
} from "../../../services/claudettePlugins";
import {
  listVoiceProviders,
  prepareVoiceProvider,
  removeVoiceProviderModel,
  setSelectedVoiceProvider,
  setVoiceProviderEnabled,
} from "../../../services/voice";
import type {
  ClaudettePluginInfo,
  ClaudettePluginKind,
  PluginSettingField,
} from "../../../types/claudettePlugins";
import type { VoiceDownloadProgress, VoiceProviderInfo } from "../../../types/voice";
import styles from "../Settings.module.css";

const KIND_ORDER: ClaudettePluginKind[] = ["scm", "env-provider"];

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function PluginsSettings() {
  const { t } = useTranslation("settings");
  const [plugins, setPlugins] = useState<ClaudettePluginInfo[] | null>(null);
  const [builtins, setBuiltins] = useState<BuiltinPluginInfo[] | null>(null);
  const [voiceProviders, setVoiceProviders] = useState<VoiceProviderInfo[] | null>(null);
  const [preparingVoiceProvider, setPreparingVoiceProvider] = useState<string | null>(null);
  const [voiceProgress, setVoiceProgress] = useState<Record<string, VoiceDownloadProgress>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reseedMessage, setReseedMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [luaResult, builtinResult, voiceResult] = await Promise.all([
        listClaudettePlugins(),
        listBuiltinClaudettePlugins(),
        listVoiceProviders(),
      ]);
      setPlugins(luaResult);
      setBuiltins(builtinResult);
      setVoiceProviders(voiceResult);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshPlugins = useCallback(async () => {
    try {
      setPlugins(await listClaudettePlugins());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshBuiltins = useCallback(async () => {
    try {
      setBuiltins(await listBuiltinClaudettePlugins());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshVoice = useCallback(async () => {
    try {
      setVoiceProviders(await listVoiceProviders());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleToggleBuiltin = useCallback(
    async (pluginName: string, nextEnabled: boolean) => {
      try {
        await setBuiltinClaudettePluginEnabled(pluginName, nextEnabled);
        await refreshBuiltins();
      } catch (e) {
        setError(String(e));
      }
    },
    [refreshBuiltins],
  );

  const handleSelectVoiceProvider = useCallback(
    async (providerId: string) => {
      try {
        await setSelectedVoiceProvider(providerId);
        await refreshVoice();
      } catch (e) {
        setError(String(e));
      }
    },
    [refreshVoice],
  );

  const handleToggleVoiceProvider = useCallback(
    async (providerId: string, nextEnabled: boolean) => {
      try {
        await setVoiceProviderEnabled(providerId, nextEnabled);
        await refreshVoice();
      } catch (e) {
        setError(String(e));
      }
    },
    [refreshVoice],
  );

  const handlePrepareVoiceProvider = useCallback(
    async (providerId: string) => {
      setPreparingVoiceProvider(providerId);
      try {
        await prepareVoiceProvider(providerId);
        await refreshVoice();
      } catch (e) {
        setError(String(e));
        await refreshVoice();
      } finally {
        setPreparingVoiceProvider(null);
      }
    },
    [refreshVoice],
  );

  const handleRemoveVoiceProviderModel = useCallback(
    async (providerId: string) => {
      try {
        await removeVoiceProviderModel(providerId);
        await refreshVoice();
      } catch (e) {
        setError(String(e));
      }
    },
    [refreshVoice],
  );

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const voiceProviderFocus = useAppStore((s) => s.voiceProviderFocus);
  const focusVoiceProvider = useAppStore((s) => s.focusVoiceProvider);
  useEffect(() => {
    if (!voiceProviderFocus) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(`voice:${voiceProviderFocus}`);
      return next;
    });
    focusVoiceProvider(null);
  }, [voiceProviderFocus, focusVoiceProvider]);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;
    listen<VoiceDownloadProgress>("voice-download-progress", (event) => {
      if (!mounted) return;
      setVoiceProgress((prev) => ({
        ...prev,
        [event.payload.providerId]: event.payload,
      }));
    }).then((fn) => {
      if (mounted) unlisten = fn;
      else fn();
    }).catch((e) => console.warn("Failed to listen for voice download progress:", e));
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  const toggleExpanded = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleToggle = useCallback(
    async (pluginName: string, nextEnabled: boolean) => {
      try {
        await setClaudettePluginEnabled(pluginName, nextEnabled);
        await refreshPlugins();
      } catch (e) {
        setError(String(e));
      }
    },
    [refreshPlugins],
  );

  const handleSettingChange = useCallback(
    async (pluginName: string, key: string, value: unknown) => {
      try {
        await setClaudettePluginSetting(pluginName, key, value);
        await refreshPlugins();
      } catch (e) {
        setError(String(e));
      }
    },
    [refreshPlugins],
  );

  const handleReseed = useCallback(async () => {
    setReseedMessage(null);
    try {
      const warnings = await reseedBundledPlugins();
      setReseedMessage(
        warnings.length === 0
          ? t("plugins_reseeded")
          : t("plugins_reseeded_warnings", { count: warnings.length, warnings: warnings.join("; ") }),
      );
      await refreshPlugins();
    } catch (e) {
      setError(String(e));
    }
  }, [refreshPlugins, t]);

  if (error) {
    return (
      <div>
        <h2 className={styles.sectionTitle}>{t("plugins_title")}</h2>
        <div className={styles.mcpError} role="alert">
          {t("plugins_load_error", { error })}
        </div>
      </div>
    );
  }

  if (loading && plugins === null) {
    return (
      <div>
        <h2 className={styles.sectionTitle}>{t("plugins_title")}</h2>
        <div className={styles.settingDescription}>{t("plugins_loading")}</div>
      </div>
    );
  }

  const items = plugins ?? [];
  const grouped = KIND_ORDER.map((kind) => ({
    kind,
    items: items.filter((p) => p.kind === kind),
  })).filter((g) => g.items.length > 0);

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("plugins_title")}</h2>
      <div className={styles.settingDescription}>
        {t("plugins_desc")}{" "}
        <em>{t("plugins_desc_note")}</em>
      </div>

      {builtins && builtins.length > 0 && (
        <div className={styles.fieldGroup}>
          <div className={styles.mcpGroupLabel}>{t("plugins_builtins_label")}</div>
          <div className={styles.mcpList}>
            {builtins.map((p) => {
              const key = `builtin:${p.name}`;
              return (
                <BuiltinPluginRow
                  key={p.name}
                  plugin={p}
                  expanded={expanded.has(key)}
                  onToggleExpand={() => toggleExpanded(key)}
                  onToggleEnabled={(next) => handleToggleBuiltin(p.name, next)}
                />
              );
            })}
          </div>
        </div>
      )}

      {voiceProviders && voiceProviders.length > 0 && (
        <div className={styles.fieldGroup}>
          <div className={styles.mcpGroupLabel}>{t("plugins_voice_label")}</div>
          <div className={styles.mcpList}>
            {voiceProviders.map((provider) => {
              const key = `voice:${provider.id}`;
              return (
                <VoiceProviderRow
                  key={provider.id}
                  provider={provider}
                  expanded={expanded.has(key)}
                  preparing={preparingVoiceProvider === provider.id}
                  progress={voiceProgress[provider.id]}
                  onToggleExpand={() => toggleExpanded(key)}
                  onSelect={() => handleSelectVoiceProvider(provider.id)}
                  onToggleEnabled={(next) =>
                    handleToggleVoiceProvider(provider.id, next)
                  }
                  onPrepare={() => handlePrepareVoiceProvider(provider.id)}
                  onRemoveModel={() =>
                    handleRemoveVoiceProviderModel(provider.id)
                  }
                />
              );
            })}
          </div>
        </div>
      )}

      {grouped.length === 0 && (
        <div className={styles.settingDescription}>{t("plugins_none")}</div>
      )}

      {grouped.map(({ kind, items }) => (
        <div key={kind} className={styles.fieldGroup}>
          <div className={styles.mcpGroupLabel}>
            {kind === "scm" ? t("plugins_kind_scm") : t("plugins_kind_env_provider")}
          </div>
          <div className={styles.mcpList}>
            {items.map((plugin) => (
              <PluginRow
                key={plugin.name}
                plugin={plugin}
                expanded={expanded.has(plugin.name)}
                onToggleExpand={() => toggleExpanded(plugin.name)}
                onToggleEnabled={(next) => handleToggle(plugin.name, next)}
                onSettingChange={(key, value) =>
                  handleSettingChange(plugin.name, key, value)
                }
              />
            ))}
          </div>
        </div>
      ))}

      <div className={styles.buttonRow}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={handleReseed}
        >
          {t("plugins_reload")}
        </button>
        {reseedMessage && (
          <span className={styles.settingDescription}>{reseedMessage}</span>
        )}
      </div>
    </div>
  );
}

interface PluginRowProps {
  plugin: ClaudettePluginInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onSettingChange: (key: string, value: unknown) => void;
}

interface VoiceProviderRowProps {
  provider: VoiceProviderInfo;
  expanded: boolean;
  preparing: boolean;
  progress: VoiceDownloadProgress | undefined;
  onToggleExpand: () => void;
  onSelect: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onPrepare: () => void;
  onRemoveModel: () => void;
}

function VoiceProviderRow({
  provider,
  expanded,
  preparing,
  progress,
  onToggleExpand,
  onSelect,
  onToggleEnabled,
  onPrepare,
  onRemoveModel,
}: VoiceProviderRowProps) {
  const { t } = useTranslation("settings");
  const dotColor = !provider.enabled
    ? "var(--text-faint)"
    : provider.status === "ready"
      ? "var(--status-running)"
      : provider.status === "error" || provider.status === "engine-unavailable"
        ? "var(--status-stopped)"
        : "var(--accent-primary)";
  const badge = provider.selected ? `selected - ${provider.statusLabel}` : provider.statusLabel;
  const canDownload =
    provider.downloadRequired &&
    provider.enabled &&
    (provider.status === "needs-setup" || provider.status === "error");
  const canPreparePlatform =
    !provider.downloadRequired &&
    provider.enabled &&
    provider.setupRequired &&
    (provider.status === "needs-setup" || provider.status === "error");
  const modeLabel = provider.offline
    ? "offline"
    : provider.recordingMode === "native"
      ? "native"
      : "webview";

  return (
    <div>
      <div className={styles.mcpRow}>
        <div className={styles.mcpInfo}>
          <span
            className={styles.mcpStatusDot}
            style={{ background: dotColor }}
            title={provider.statusLabel}
          />
          <span
            className={`${styles.mcpName} ${!provider.enabled ? styles.mcpNameDisabled : ""}`}
          >
            {provider.name}
          </span>
          <span className={styles.mcpBadge}>{badge}</span>
          <span className={styles.settingDescription}>{modeLabel}</span>
        </div>
        <div className={styles.mcpActions}>
          <button
            type="button"
            className={styles.envDetailsBtn}
            onClick={onToggleExpand}
            aria-expanded={expanded}
          >
            {expanded ? t("plugins_hide_details") : t("plugins_details")}
          </button>
          {!provider.selected && provider.enabled && (
            <button
              type="button"
              className={styles.envDetailsBtn}
              onClick={onSelect}
            >
              {t("plugins_voice_use")}
            </button>
          )}
          <button
            type="button"
            className={`${styles.mcpToggle} ${provider.enabled ? styles.mcpToggleOn : ""}`}
            onClick={() => onToggleEnabled(!provider.enabled)}
            role="switch"
            aria-checked={provider.enabled}
            aria-label={provider.enabled ? t("plugins_disable_aria", { name: provider.name }) : t("plugins_enable_aria", { name: provider.name })}
          >
            <span className={styles.mcpToggleKnob} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className={styles.envErrorCard}>
          <div className={styles.settingDescription}>
            {provider.description}
          </div>
          <div className={styles.envErrorHint}>{provider.privacyLabel}</div>
          {provider.modelSizeLabel && (
            <div className={styles.envErrorHint}>
              {t("plugins_voice_model_size", { label: provider.modelSizeLabel })}
            </div>
          )}
          {provider.cachePath && (
            <div className={styles.envErrorHint}>
              {t("plugins_voice_cache_path")} <code>{provider.cachePath}</code>
            </div>
          )}
          {provider.acceleratorLabel && (
            <div className={styles.envErrorHint}>
              {t("plugins_voice_acceleration", { label: provider.acceleratorLabel })}
            </div>
          )}
          {provider.error && (
            <div className={styles.envErrorHint}>
              <strong style={{ color: "var(--status-stopped)" }}>
                {provider.error}
              </strong>
            </div>
          )}
          {progress && (provider.status === "downloading" || preparing) && (
            <div className={styles.envErrorHint}>
              {t("plugins_voice_downloading_progress", {
                filename: progress.filename,
                progress: progress.percent === null
                  ? formatBytes(progress.overallDownloadedBytes)
                  : `${Math.round(progress.percent * 100)}%`,
              })}
            </div>
          )}
          <div className={styles.buttonRow}>
            {canDownload && (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={onPrepare}
                disabled={preparing}
              >
                {preparing ? t("plugins_voice_downloading") : t("plugins_voice_download_model")}
              </button>
            )}
            {canPreparePlatform && (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={onPrepare}
                disabled={preparing}
              >
                {preparing ? t("plugins_voice_preparing") : t("plugins_voice_setup_permissions")}
              </button>
            )}
            {provider.status === "downloading" && (
              <button type="button" className={styles.iconBtn} disabled>
                {t("plugins_voice_downloading")}
              </button>
            )}
            {provider.canRemoveModel && (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={onRemoveModel}
              >
                {t("plugins_voice_remove_model")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PluginRow({
  plugin,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onSettingChange,
}: PluginRowProps) {
  const { t } = useTranslation("settings");
  const hasSettings = plugin.settings_schema.length > 0;
  const hasCliIssue = !plugin.cli_available;
  const dotColor = !plugin.enabled
    ? "var(--text-faint)"
    : hasCliIssue
      ? "var(--status-stopped)"
      : "var(--status-running)";
  const badge = !plugin.enabled
    ? t("plugins_badge_disabled")
    : hasCliIssue
      ? t("plugins_badge_cli_missing")
      : t("plugins_badge_loaded");

  return (
    <div>
      <div className={styles.mcpRow}>
        <div className={styles.mcpInfo}>
          <span
            className={styles.mcpStatusDot}
            style={{ background: dotColor }}
            title={badge}
          />
          <span
            className={`${styles.mcpName} ${!plugin.enabled ? styles.mcpNameDisabled : ""}`}
          >
            {plugin.display_name}
          </span>
          <span className={styles.mcpBadge}>{badge}</span>
          <span className={styles.settingDescription}>
            v{plugin.version}
          </span>
        </div>
        <div className={styles.mcpActions}>
          {(hasSettings || hasCliIssue) && (
            <button
              type="button"
              className={styles.envDetailsBtn}
              onClick={onToggleExpand}
              aria-expanded={expanded}
            >
              {expanded ? t("plugins_hide_details") : t("plugins_details")}
            </button>
          )}
          <button
            type="button"
            className={`${styles.mcpToggle} ${plugin.enabled ? styles.mcpToggleOn : ""}`}
            onClick={() => onToggleEnabled(!plugin.enabled)}
            role="switch"
            aria-checked={plugin.enabled}
            aria-label={plugin.enabled ? t("plugins_disable_aria", { name: plugin.display_name }) : t("plugins_enable_aria", { name: plugin.display_name })}
          >
            <span className={styles.mcpToggleKnob} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className={styles.envErrorCard}>
          <div className={styles.settingDescription}>
            {plugin.description}
          </div>
          {plugin.required_clis.length > 0 && (
            <div className={styles.envErrorHint}>
              {t("plugins_requires")}{" "}
              {plugin.required_clis.map((cli, i) => (
                <span key={cli}>
                  {i > 0 && ", "}
                  <code>{cli}</code>
                </span>
              ))}
              {hasCliIssue && (
                <>
                  {" "}
                  <strong style={{ color: "var(--status-stopped)" }}>
                    {t("plugins_cli_not_found")}
                  </strong>
                </>
              )}
            </div>
          )}
          {hasSettings && (
            <div className={styles.pluginSettingsForm}>
              {plugin.settings_schema.map((field) => (
                <SettingInput
                  key={field.key}
                  field={field}
                  value={plugin.setting_values[field.key]}
                  onChange={(value) => onSettingChange(field.key, value)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SettingInput({
  field,
  value,
  onChange,
}: {
  field: PluginSettingField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "boolean") {
    const checked = value === true;
    return (
      <label className={styles.pluginSettingRow}>
        <button
          type="button"
          className={`${styles.mcpToggle} ${checked ? styles.mcpToggleOn : ""}`}
          onClick={() => onChange(!checked)}
          role="switch"
          aria-checked={checked}
          aria-label={field.label}
        >
          <span className={styles.mcpToggleKnob} />
        </button>
        <div>
          <div className={styles.pluginSettingLabel}>{field.label}</div>
          {field.description && (
            <div className={styles.envErrorHint}>{field.description}</div>
          )}
        </div>
      </label>
    );
  }

  if (field.type === "text") {
    const stringValue = typeof value === "string" ? value : (field.default ?? "");
    return (
      <div className={styles.pluginSettingRow}>
        <div>
          <div className={styles.pluginSettingLabel}>{field.label}</div>
          {field.description && (
            <div className={styles.envErrorHint}>{field.description}</div>
          )}
          <input
            type="text"
            value={stringValue}
            placeholder={field.placeholder ?? ""}
            onChange={(e) => onChange(e.target.value || null)}
            className={styles.textInput}
          />
        </div>
      </div>
    );
  }

  // select
  const stringValue = typeof value === "string" ? value : (field.default ?? "");
  return (
    <div className={styles.pluginSettingRow}>
      <div>
        <div className={styles.pluginSettingLabel}>{field.label}</div>
        {field.description && (
          <div className={styles.envErrorHint}>{field.description}</div>
        )}
        <select
          value={stringValue}
          onChange={(e) => onChange(e.target.value || null)}
          className={styles.textInput}
        >
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

interface BuiltinPluginRowProps {
  plugin: BuiltinPluginInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}

export function BuiltinPluginRow({
  plugin,
  expanded,
  onToggleExpand,
  onToggleEnabled,
}: BuiltinPluginRowProps) {
  const { t } = useTranslation("settings");
  const dotColor = plugin.enabled
    ? "var(--status-running)"
    : "var(--text-faint)";
  const badge = plugin.enabled ? t("plugins_badge_loaded") : t("plugins_badge_disabled");
  return (
    <div>
      <div className={styles.mcpRow}>
        <div className={styles.mcpInfo}>
          <span
            className={styles.mcpStatusDot}
            style={{ background: dotColor }}
            title={badge}
          />
          <span
            className={`${styles.mcpName} ${!plugin.enabled ? styles.mcpNameDisabled : ""}`}
          >
            {plugin.title}
          </span>
          <span className={styles.mcpBadge}>{badge}</span>
        </div>
        <div className={styles.mcpActions}>
          <button
            type="button"
            className={styles.envDetailsBtn}
            onClick={onToggleExpand}
            aria-expanded={expanded}
          >
            {expanded ? t("plugins_hide_details") : t("plugins_details")}
          </button>
          <button
            type="button"
            className={`${styles.mcpToggle} ${plugin.enabled ? styles.mcpToggleOn : ""}`}
            onClick={() => onToggleEnabled(!plugin.enabled)}
            role="switch"
            aria-checked={plugin.enabled}
            aria-label={plugin.enabled ? t("plugins_disable_aria", { name: plugin.title }) : t("plugins_enable_aria", { name: plugin.title })}
          >
            <span className={styles.mcpToggleKnob} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className={styles.envErrorCard}>
          <div className={styles.settingDescription}>{plugin.description}</div>
        </div>
      )}
    </div>
  );
}
