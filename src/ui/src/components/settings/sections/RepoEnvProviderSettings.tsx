/**
 * Per-repo overrides for env-provider plugin settings (timeout, etc.).
 * Renders below the EnvPanel in Repo Settings → Environment.
 *
 * Each visible env-provider plugin gets a card listing its
 * manifest-declared settings; the user can override any of them on a
 * per-repo basis. Clearing a field reverts the repo to the global
 * plugin default. Reuses `PluginSettingInput` from PluginsSettings so
 * the boolean / text / select / number inputs behave identically.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getClaudettePluginRepoSettings,
  listClaudettePlugins,
  setClaudettePluginRepoSetting,
} from "../../../services/claudettePlugins";
import type { ClaudettePluginInfo } from "../../../types/claudettePlugins";
import { PluginSettingInput } from "../PluginSettingInput";
import styles from "../Settings.module.css";

interface RepoEnvProviderSettingsProps {
  repoId: string;
}

export function RepoEnvProviderSettings({ repoId }: RepoEnvProviderSettingsProps) {
  const { t } = useTranslation("settings");
  const [plugins, setPlugins] = useState<ClaudettePluginInfo[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Record<string, unknown>>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load env-provider plugins + their per-repo overrides. Keep them
  // separate from the global setting_values so the form can render a
  // "uses global default" affordance for keys with no per-repo entry.
  const refresh = useCallback(async () => {
    try {
      const all = await listClaudettePlugins();
      // Only list providers that are globally enabled. A plugin
      // disabled in Settings → Plugins won't run anyway (the runtime
      // short-circuits with `PluginDisabled` regardless of per-repo
      // overrides), so showing its config form here would mislead the
      // user into thinking they could re-enable it just for this repo
      // — they can't. Disabling globally is the only path to disable a
      // provider; per-repo overrides exist only to *tune* an enabled
      // provider's behavior. Hiding disabled providers also keeps the
      // panel from drifting out of sync with what the global Plugins
      // page shows as the source of truth.
      const envProviders = all.filter(
        (p) =>
          p.kind === "env-provider" && p.enabled && p.settings_schema.length > 0,
      );
      const overridesByPlugin: Record<string, Record<string, unknown>> = {};
      await Promise.all(
        envProviders.map(async (p) => {
          overridesByPlugin[p.name] = await getClaudettePluginRepoSettings(
            repoId,
            p.name,
          );
        }),
      );
      setPlugins(envProviders);
      setOverrides(overridesByPlugin);
      setLoaded(true);
    } catch (e) {
      setError(String(e));
      setLoaded(true);
    }
  }, [repoId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleChange = useCallback(
    async (pluginName: string, key: string, value: unknown) => {
      try {
        await setClaudettePluginRepoSetting(repoId, pluginName, key, value);
        // Optimistic update so the form doesn't bounce while the
        // backend round-trips. `null` means "use the global default"
        // — drop the key from the override map so the next render
        // shows the global value as the placeholder.
        setOverrides((prev) => {
          const nextPluginOverrides = { ...(prev[pluginName] ?? {}) };
          if (value === null) {
            delete nextPluginOverrides[key];
          } else {
            nextPluginOverrides[key] = value;
          }
          return { ...prev, [pluginName]: nextPluginOverrides };
        });
      } catch (e) {
        setError(String(e));
      }
    },
    [repoId],
  );

  if (!loaded) {
    return null;
  }
  if (plugins.length === 0) {
    return null;
  }

  return (
    <div className={styles.fieldGroup}>
      <div className={styles.fieldLabel}>
        {t("repo_env_provider_overrides_label", "Env provider overrides")}
      </div>
      <div className={`${styles.fieldHint} ${styles.fieldHintSpaced}`}>
        {t(
          "repo_env_provider_overrides_hint",
          "Override env-provider settings for this repo. Empty fields fall back to the global Plugins settings.",
        )}
      </div>
      {error && (
        <div className={styles.overrideNotice} role="alert">
          {error}
        </div>
      )}
      <div className={styles.repoEnvProviderList}>
        {plugins.map((plugin) => {
          const repoOverrides = overrides[plugin.name] ?? {};
          return (
            <div key={plugin.name} className={styles.repoEnvProviderCard}>
              <div className={styles.repoEnvProviderHeader}>
                <span className={styles.repoEnvProviderName}>
                  {plugin.display_name}
                </span>
                <span className={styles.repoEnvProviderInternal}>
                  {plugin.name}
                </span>
              </div>
              <div className={styles.pluginSettingsForm}>
                {plugin.settings_schema.map((field) => {
                  const overrideValue = repoOverrides[field.key];
                  // When no per-repo override is set, show the
                  // current global value (from setting_values) so the
                  // user can see what the workspace will inherit.
                  // Empty / clear is what flips us back to that.
                  const value =
                    overrideValue !== undefined
                      ? overrideValue
                      : plugin.setting_values[field.key];
                  const overridden = overrideValue !== undefined;
                  return (
                    <div
                      key={field.key}
                      className={
                        overridden
                          ? `${styles.repoEnvProviderField} ${styles.repoEnvProviderFieldOverridden}`
                          : styles.repoEnvProviderField
                      }
                    >
                      <PluginSettingInput
                        field={field}
                        value={value}
                        onChange={(v) => handleChange(plugin.name, field.key, v)}
                      />
                      {overridden && (
                        <button
                          type="button"
                          className={styles.repoEnvProviderClearBtn}
                          onClick={() =>
                            handleChange(plugin.name, field.key, null)
                          }
                        >
                          {t(
                            "repo_env_provider_use_global",
                            "Use global default",
                          )}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
