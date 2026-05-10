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
import { listLanguageGrammars } from "../../../services/grammars";
import { refreshGrammars } from "../../../utils/grammarRegistry";
import type { LanguageInfo } from "../../../types/grammars";
import type {
  ClaudettePluginInfo,
  ClaudettePluginKind,
} from "../../../types/claudettePlugins";
import type { VoiceDownloadProgress, VoiceProviderInfo } from "../../../types/voice";
import { PluginSettingInput } from "../PluginSettingInput";
import styles from "../Settings.module.css";

const KIND_ORDER: ClaudettePluginKind[] = ["scm", "env-provider", "language-grammar"];
type PluginLoadErrorKey = "lua" | "builtins" | "voice";

function emptyLoadErrors(): Record<PluginLoadErrorKey, string | null> {
  return {
    lua: null,
    builtins: null,
    voice: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Returns a literal union (not bare `string`) so the i18next `t()`
// surface still type-checks the key against the locales file.
function kindLabelKey(
  kind: ClaudettePluginKind,
): "plugins_kind_scm" | "plugins_kind_env_provider" | "plugins_kind_language_grammar" {
  switch (kind) {
    case "scm":
      return "plugins_kind_scm";
    case "env-provider":
      return "plugins_kind_env_provider";
    case "language-grammar":
      return "plugins_kind_language_grammar";
  }
}

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
  // Map plugin name → languages it contributes. Only populated for
  // language-grammar plugins; other kinds resolve to undefined and the
  // PluginRow falls back to the default (no extension chips).
  const [grammarLanguages, setGrammarLanguages] = useState<
    Map<string, LanguageInfo[]>
  >(() => new Map());
  const [preparingVoiceProvider, setPreparingVoiceProvider] = useState<string | null>(null);
  const [voiceProgress, setVoiceProgress] = useState<Record<string, VoiceDownloadProgress>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadErrors, setLoadErrors] = useState<Record<PluginLoadErrorKey, string | null>>(
    emptyLoadErrors,
  );
  const [reseedMessage, setReseedMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [luaResult, builtinResult, voiceResult, grammarResult] =
      await Promise.allSettled([
        listClaudettePlugins(),
        listBuiltinClaudettePlugins(),
        listVoiceProviders(),
        // Grammar registry returns only enabled plugins, so a
        // disabled language-grammar plugin shows up in `luaResult`
        // (no chips) but not in `grammarResult` — that's the
        // intended UX cue (chips appear only when active).
        listLanguageGrammars(),
      ]);

    const nextLoadErrors = emptyLoadErrors();
    if (luaResult.status === "fulfilled") {
      setPlugins(luaResult.value);
    } else {
      nextLoadErrors.lua = errorMessage(luaResult.reason);
      setPlugins(null);
    }

    if (builtinResult.status === "fulfilled") {
      setBuiltins(builtinResult.value);
    } else {
      nextLoadErrors.builtins = errorMessage(builtinResult.reason);
      setBuiltins(null);
    }

    if (voiceResult.status === "fulfilled") {
      setVoiceProviders(voiceResult.value);
    } else {
      nextLoadErrors.voice = errorMessage(voiceResult.reason);
      setVoiceProviders(null);
    }

    if (grammarResult.status === "fulfilled") {
      const byPlugin = new Map<string, LanguageInfo[]>();
      for (const lang of grammarResult.value.languages) {
        const existing = byPlugin.get(lang.plugin_name) ?? [];
        existing.push(lang);
        byPlugin.set(lang.plugin_name, existing);
      }
      setGrammarLanguages(byPlugin);
    }

    setLoadErrors(nextLoadErrors);
    setLoading(false);
  }, []);

  const refreshPlugins = useCallback(async () => {
    setError(null);
    try {
      setPlugins(await listClaudettePlugins());
      setLoadErrors((prev) => ({ ...prev, lua: null }));
    } catch (e) {
      setLoadErrors((prev) => ({ ...prev, lua: errorMessage(e) }));
    }
  }, []);

  const refreshGrammarLanguages = useCallback(async () => {
    // The grammar registry filters disabled plugins on the backend,
    // so toggling a language-grammar plugin must refresh this list
    // for the per-plugin "File extensions" chips to reflect reality.
    try {
      const result = await listLanguageGrammars();
      const byPlugin = new Map<string, LanguageInfo[]>();
      for (const lang of result.languages) {
        const existing = byPlugin.get(lang.plugin_name) ?? [];
        existing.push(lang);
        byPlugin.set(lang.plugin_name, existing);
      }
      setGrammarLanguages(byPlugin);
    } catch {
      // Soft-fail: a transient backend hiccup shouldn't reset the
      // chips to empty for every plugin. Keep the previous snapshot.
    }
  }, []);

  const refreshBuiltins = useCallback(async () => {
    setError(null);
    try {
      setBuiltins(await listBuiltinClaudettePlugins());
      setLoadErrors((prev) => ({ ...prev, builtins: null }));
    } catch (e) {
      setLoadErrors((prev) => ({ ...prev, builtins: errorMessage(e) }));
    }
  }, []);

  const refreshVoice = useCallback(async () => {
    setError(null);
    try {
      setVoiceProviders(await listVoiceProviders());
      setLoadErrors((prev) => ({ ...prev, voice: null }));
    } catch (e) {
      setLoadErrors((prev) => ({ ...prev, voice: errorMessage(e) }));
    }
  }, []);

  const handleToggleBuiltin = useCallback(
    async (pluginName: string, nextEnabled: boolean) => {
      try {
        await setBuiltinClaudettePluginEnabled(pluginName, nextEnabled);
        await refreshBuiltins();
      } catch (e) {
        setError(errorMessage(e));
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
        setError(errorMessage(e));
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
        setError(errorMessage(e));
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
        setError(errorMessage(e));
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
        setError(errorMessage(e));
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
        // Refresh both: `refreshPlugins` updates the enabled badge
        // for every plugin kind; `refreshGrammarLanguages` keeps the
        // language-grammar chips in sync with the backend's
        // enabled-only registry.
        await Promise.all([refreshPlugins(), refreshGrammarLanguages()]);
        // Hot-reload the grammar registry if the toggled plugin
        // contributes grammars (issue 570). Without this the
        // toggle would only take effect after an app restart —
        // grammars are cached at boot and consumed by the chat
        // worker, main-thread Shiki, and Monaco.
        const toggled = plugins?.find((p) => p.name === pluginName);
        if (toggled?.kind === "language-grammar") {
          await refreshGrammars();
        }
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [refreshPlugins, refreshGrammarLanguages, plugins],
  );

  const handleSettingChange = useCallback(
    async (pluginName: string, key: string, value: unknown) => {
      try {
        await setClaudettePluginSetting(pluginName, key, value);
        await refreshPlugins();
      } catch (e) {
        setError(errorMessage(e));
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
      setError(errorMessage(e));
    }
  }, [refreshPlugins, t]);

  const hasAnyLoadError = Object.values(loadErrors).some(Boolean);
  const hasAnyLoadedGroup =
    plugins !== null || builtins !== null || voiceProviders !== null;

  if (loading && !hasAnyLoadedGroup && !hasAnyLoadError) {
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
      {error && (
        <div className={styles.mcpError} role="alert">
          {t("plugins_action_error", { error })}
        </div>
      )}

      {loadErrors.builtins ? (
        <div className={styles.fieldGroup}>
          <div className={styles.mcpGroupLabel}>{t("plugins_builtins_label")}</div>
          <div className={styles.mcpList}>
            <PluginGroupErrorRow
              name={t("plugins_builtins_label")}
              error={loadErrors.builtins}
            />
          </div>
        </div>
      ) : builtins && builtins.length > 0 && (
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

      {loadErrors.voice ? (
        <div className={styles.fieldGroup}>
          <div className={styles.mcpGroupLabel}>{t("plugins_voice_label")}</div>
          <div className={styles.mcpList}>
            <PluginGroupErrorRow
              name={t("plugins_voice_label")}
              error={loadErrors.voice}
            />
          </div>
        </div>
      ) : voiceProviders && voiceProviders.length > 0 && (
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

      {loadErrors.lua && (
        <div className={styles.fieldGroup}>
          <div className={styles.mcpGroupLabel}>{t("plugins_claudette_label")}</div>
          <div className={styles.mcpList}>
            <PluginGroupErrorRow
              name={t("plugins_claudette_label")}
              error={loadErrors.lua}
            />
          </div>
        </div>
      )}

      {grouped.length === 0 && !loadErrors.lua && (
        <div className={styles.settingDescription}>{t("plugins_none")}</div>
      )}

      {grouped.map(({ kind, items }) => (
        <div key={kind} className={styles.fieldGroup}>
          <div className={styles.mcpGroupLabel}>{t(kindLabelKey(kind))}</div>
          <div className={styles.mcpList}>
            {items.map((plugin) => (
              <PluginRow
                key={plugin.name}
                plugin={plugin}
                languages={grammarLanguages.get(plugin.name)}
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

function PluginGroupErrorRow({
  name,
  error,
}: {
  name: string;
  error: string;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className={styles.mcpRow} role="alert">
      <div className={styles.mcpInfo}>
        <span
          className={styles.mcpStatusDot}
          style={{ background: "var(--status-stopped)" }}
          title={t("plugins_badge_error")}
        />
        <span className={styles.mcpName}>{name}</span>
        <span className={styles.mcpBadge}>{t("plugins_badge_error")}</span>
        <span className={styles.mcpError} title={error}>
          {t("plugins_group_load_error", { error })}
        </span>
      </div>
    </div>
  );
}

interface PluginRowProps {
  plugin: ClaudettePluginInfo;
  /** Languages contributed by this plugin (only set for `language-grammar` kind). */
  languages?: LanguageInfo[];
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
  const canToggle = provider.status !== "unavailable";
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
            disabled={!canToggle}
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
  languages,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onSettingChange,
}: PluginRowProps) {
  const { t } = useTranslation("settings");
  const hasSettings = plugin.settings_schema.length > 0;
  // Grammar plugins ship no `required_clis`; surface their extension
  // contributions instead so the row carries useful detail when
  // expanded.
  const isGrammar = plugin.kind === "language-grammar";
  // Multiple LanguageInfo entries from the same plugin may contribute
  // overlapping extensions (e.g. two language ids both claiming
  // `.json`). Deduplicate so the UI shows each extension once and so
  // React keys stay unique. Set preserves insertion order, which keeps
  // the chip layout stable across renders.
  const grammarExtensions = isGrammar
    ? Array.from(new Set((languages ?? []).flatMap((l) => l.extensions)))
    : [];
  const hasGrammarExtensions = grammarExtensions.length > 0;
  // CLI checks are meaningless for grammar plugins (no executables to
  // detect), so collapse the issue logic into "false" for that kind.
  const hasCliIssue = isGrammar ? false : !plugin.cli_available;
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
          {(hasSettings || hasCliIssue || hasGrammarExtensions) && (
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
          {hasGrammarExtensions && (
            <div className={styles.envErrorHint}>
              {t("plugins_grammar_extensions")}{" "}
              {grammarExtensions.map((ext, i) => (
                <span key={ext}>
                  {i > 0 && ", "}
                  <code>{ext}</code>
                </span>
              ))}
            </div>
          )}
          {hasSettings && (
            <div className={styles.pluginSettingsForm}>
              {plugin.settings_schema.map((field) => (
                <PluginSettingInput
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
