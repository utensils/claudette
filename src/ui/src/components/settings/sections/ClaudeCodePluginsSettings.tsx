import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { ensureAndValidateMcps } from "../../../services/mcp";
import {
  addPluginMarketplace,
  disablePlugin,
  enablePlugin,
  installPlugin,
  listPluginCatalog,
  listPluginMarketplaces,
  loadPluginConfiguration,
  removePluginMarketplace,
  savePluginChannelConfiguration,
  savePluginTopLevelConfiguration,
  uninstallPlugin,
  updateAllPlugins,
  updatePlugin,
  updatePluginMarketplace,
} from "../../../services/tauri";
import { useAppStore } from "../../../stores/useAppStore";
import type {
  AvailablePlugin,
  EditablePluginScope,
  InstalledPlugin,
  PluginConfigSection,
  PluginConfiguration,
  PluginMarketplace,
  PluginSettingsAction,
  PluginScope,
} from "../../../types/plugins";
import {
  availablePluginLinks,
  canInstallAvailablePluginAtScope,
  formatInstallCount,
  marketplaceSourceLink,
  matchesAvailablePlugin,
  matchesInstalledPlugin,
  matchesMarketplace,
  primaryInstalledScope,
  sortAvailablePlugins,
  summarizeAvailablePlugins,
  summarizeInstalledPlugins,
} from "./pluginCatalog";
import styles from "../Settings.module.css";
import { openUrl } from "../../../services/tauri";

type TFn = TFunction<"settings">;

type DraftValues = Record<string, string | boolean>;

function scopeNeedsRepo(scope: EditablePluginScope): boolean {
  return scope === "project" || scope === "local";
}

function hasConfig(plugin: InstalledPlugin): boolean {
  return (
    Object.keys(plugin.user_config_schema).length > 0
    || plugin.channels.some((channel) => Object.keys(channel.config_schema).length > 0)
  );
}

function buildDraft(section: PluginConfigSection): DraftValues {
  const draft: DraftValues = {};
  for (const [key, field] of Object.entries(section.schema)) {
    if (field.sensitive) {
      draft[key] = "";
      continue;
    }
    const value = section.state.values[key];
    if (field.type === "boolean") {
      draft[key] = value === true;
    } else if (field.multiple && Array.isArray(value)) {
      draft[key] = value.join("\n");
    } else if (value === undefined || value === null) {
      draft[key] = "";
    } else {
      draft[key] = String(value);
    }
  }
  return draft;
}

function buildPayload(
  section: PluginConfigSection,
  draft: DraftValues,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(section.schema)) {
    const value = draft[key];
    if (field.sensitive) {
      if (typeof value === "string" && value.trim() !== "") {
        payload[key] = field.multiple
          ? value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
          : value;
      }
      continue;
    }
    if (field.type === "boolean") {
      payload[key] = value === true;
      continue;
    }
    if (field.multiple) {
      payload[key] = typeof value === "string"
        ? value
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        : [];
      continue;
    }
    payload[key] = typeof value === "string" ? value : "";
  }
  return payload;
}

function installedPluginSelectionKey(plugin: Pick<InstalledPlugin, "plugin_id" | "scope">): string {
  return `${plugin.plugin_id}::${plugin.scope}`;
}

function repoAvailabilityDetail(t: TFn, scope: PluginScope, hasRepoContext: boolean): string | null {
  if (!hasRepoContext) return null;
  if (scope === "user" || scope === "managed") {
    return t("ccp_available_via_scope", { scope });
  }
  return null;
}

function matchesPluginTarget(plugin: InstalledPlugin, target: string): boolean {
  const normalizedTarget = target.trim().toLowerCase();
  if (!normalizedTarget) return false;
  return (
    normalizedTarget === plugin.plugin_id.toLowerCase()
    || normalizedTarget === plugin.name.toLowerCase()
  );
}

function ConfigEditor({
  title,
  section,
  draft,
  onDraftChange,
  onSave,
  busy,
}: {
  title: string;
  section: PluginConfigSection;
  draft: DraftValues;
  onDraftChange: (key: string, value: string | boolean) => void;
  onSave: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className={styles.pluginConfigSection}>
      <div className={styles.pluginConfigHeader}>
        <div>
          <div className={styles.settingLabel}>{title}</div>
          <div className={styles.settingDescription}>
            {t("ccp_config_sensitive_hint")}
          </div>
        </div>
        <button className={styles.iconBtn} onClick={onSave} disabled={busy}>
          {t("ccp_save")}
        </button>
      </div>

      <div className={styles.pluginConfigFields}>
        {Object.entries(section.schema).map(([key, field]) => {
          const savedSensitive = section.state.saved_sensitive_keys.includes(key);
          return (
            <label key={key} className={styles.pluginField}>
              <span className={styles.fieldLabel}>{field.title}</span>
              <span className={styles.fieldHint}>{field.description}</span>
              {field.type === "boolean" ? (
                <input
                  type="checkbox"
                  checked={draft[key] === true}
                  onChange={(event) => onDraftChange(key, event.target.checked)}
                />
              ) : field.multiple ? (
                <textarea
                  className={styles.textarea}
                  value={String(draft[key] ?? "")}
                  onChange={(event) => onDraftChange(key, event.target.value)}
                  placeholder={field.sensitive && savedSensitive ? t("ccp_field_saved") : ""}
                />
              ) : (
                <input
                  className={styles.input}
                  type={field.sensitive ? "password" : field.type === "number" ? "number" : "text"}
                  min={field.min ?? undefined}
                  max={field.max ?? undefined}
                  value={String(draft[key] ?? "")}
                  onChange={(event) => onDraftChange(key, event.target.value)}
                  placeholder={field.sensitive && savedSensitive ? t("ccp_field_saved") : ""}
                />
              )}
              <span className={styles.pluginFieldMeta}>
                {field.required ? t("ccp_field_required") : t("ccp_field_optional")}
                {field.sensitive ? ` · ${t("ccp_field_sensitive")}` : ""}
                {savedSensitive && field.sensitive ? ` · ${t("ccp_field_secret_saved")}` : ""}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function PluginStatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className={styles.pluginStatCard}>
      <div className={styles.pluginStatValue}>{value}</div>
      <div className={styles.pluginStatLabel}>{label}</div>
      <div className={styles.pluginStatDetail}>{detail}</div>
    </div>
  );
}

function ExternalBrowserLink({
  detail,
  href,
  label,
  meta,
}: {
  detail: string;
  href: string;
  label: string;
  meta: string | null;
}) {
  return (
    <button
      type="button"
      className={styles.pluginLink}
      onClick={(event) => {
        event.preventDefault();
        void openUrl(href).catch((nextError) =>
          console.error("Failed to open plugin link:", href, nextError),
        );
      }}
    >
      <span className={styles.pluginLinkLabel}>{label}</span>
      <span className={styles.pluginLinkDetail}>{detail}</span>
      {meta && <span className={styles.pluginLinkMeta}>{meta}</span>}
    </button>
  );
}

export function ClaudeCodePluginsSettings() {
  const { t } = useTranslation("settings");
  const repositories = useAppStore((state) => state.repositories);
  const pluginSettingsTab = useAppStore((state) => state.pluginSettingsTab);
  const setPluginSettingsTab = useAppStore((state) => state.setPluginSettingsTab);
  const pluginSettingsRepoId = useAppStore((state) => state.pluginSettingsRepoId);
  const setPluginSettingsRepoId = useAppStore((state) => state.setPluginSettingsRepoId);
  const pluginSettingsIntent = useAppStore((state) => state.pluginSettingsIntent);
  const clearPluginSettingsIntent = useAppStore((state) => state.clearPluginSettingsIntent);
  const pluginRefreshToken = useAppStore((state) => state.pluginRefreshToken);
  const bumpPluginRefreshToken = useAppStore((state) => state.bumpPluginRefreshToken);
  const setMcpStatus = useAppStore((state) => state.setMcpStatus);

  const localRepositories = useMemo(
    () => repositories.filter((repo) => repo.remote_connection_id === null),
    [repositories],
  );

  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([]);
  const [availablePlugins, setAvailablePlugins] = useState<AvailablePlugin[]>([]);
  const [marketplaces, setMarketplaces] = useState<PluginMarketplace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [installTarget, setInstallTarget] = useState("");
  const [installScope, setInstallScope] = useState<EditablePluginScope>("user");
  const [availableFilter, setAvailableFilter] = useState("");
  const [pluginFilter, setPluginFilter] = useState("");
  const [selectedPluginKey, setSelectedPluginKey] = useState<string | null>(null);
  const [config, setConfig] = useState<PluginConfiguration | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [topLevelDraft, setTopLevelDraft] = useState<DraftValues>({});
  const [channelDrafts, setChannelDrafts] = useState<Record<string, DraftValues>>({});
  const [pendingActionHint, setPendingActionHint] = useState<PluginSettingsAction | null>(null);
  const [pendingTargetHint, setPendingTargetHint] = useState<string | null>(null);

  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [marketplaceScope, setMarketplaceScope] = useState<EditablePluginScope>("user");
  const [marketplaceFilter, setMarketplaceFilter] = useState("");

  const installedSummary = useMemo(
    () => summarizeInstalledPlugins(installedPlugins),
    [installedPlugins],
  );
  const availableSummary = useMemo(
    () => summarizeAvailablePlugins(availablePlugins),
    [availablePlugins],
  );
  const filteredInstalled = useMemo(
    () => installedPlugins.filter((plugin) => matchesInstalledPlugin(plugin, pluginFilter)),
    [installedPlugins, pluginFilter],
  );
  const filteredAvailable = useMemo(
    () => sortAvailablePlugins(
      availablePlugins.filter((plugin) => matchesAvailablePlugin(plugin, availableFilter)),
    ),
    [availableFilter, availablePlugins],
  );
  const filteredMarketplaces = useMemo(
    () => marketplaces.filter((marketplace) => matchesMarketplace(marketplace, marketplaceFilter)),
    [marketplaceFilter, marketplaces],
  );
  const availablePluginsById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.plugin_id, plugin])),
    [availablePlugins],
  );
  const selectedInstalledPlugin = useMemo(
    () => installedPlugins.find((plugin) => installedPluginSelectionKey(plugin) === selectedPluginKey) ?? null,
    [installedPlugins, selectedPluginKey],
  );
  const globallyInstalledPlugins = useMemo(
    () => installedPlugins.filter((plugin) => plugin.scope === "user" || plugin.scope === "managed"),
    [installedPlugins],
  );

  useEffect(() => {
    if (!pluginSettingsRepoId) return;
    if (localRepositories.some((repo) => repo.id === pluginSettingsRepoId)) return;
    setPluginSettingsRepoId(null);
  }, [localRepositories, pluginSettingsRepoId, setPluginSettingsRepoId]);

  useEffect(() => {
    if (!pluginSettingsIntent) return;

    setPluginSettingsTab(pluginSettingsIntent.tab);
    if (pluginSettingsIntent.repoId) {
      setPluginSettingsRepoId(pluginSettingsIntent.repoId);
    }
    setPendingActionHint(pluginSettingsIntent.action);
    setPendingTargetHint(pluginSettingsIntent.target ?? pluginSettingsIntent.source);

    if (pluginSettingsIntent.tab === "available") {
      setInstallScope(pluginSettingsIntent.scope);
      if (pluginSettingsIntent.source) {
        setInstallTarget(pluginSettingsIntent.source);
      }
      if (pluginSettingsIntent.target) {
        setAvailableFilter(pluginSettingsIntent.target);
      }
    } else if (pluginSettingsIntent.tab === "installed") {
      if (pluginSettingsIntent.target) {
        setPluginFilter(pluginSettingsIntent.target);
        setSelectedPluginKey(null);
      }
    } else {
      setMarketplaceScope(pluginSettingsIntent.scope);
      if (pluginSettingsIntent.source) {
        setMarketplaceSource(pluginSettingsIntent.source);
      }
      if (pluginSettingsIntent.target) {
        setMarketplaceFilter(pluginSettingsIntent.target);
      }
    }

    clearPluginSettingsIntent();
  }, [
    clearPluginSettingsIntent,
    pluginSettingsIntent,
    setPluginSettingsRepoId,
    setPluginSettingsTab,
  ]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      listPluginCatalog(pluginSettingsRepoId ?? undefined),
      listPluginMarketplaces(pluginSettingsRepoId ?? undefined),
    ])
      .then(([catalog, nextMarketplaces]) => {
        if (cancelled) return;
        setInstalledPlugins(catalog.installed);
        setAvailablePlugins(catalog.available);
        setMarketplaces(nextMarketplaces);
      })
      .catch((nextError) => {
        if (!cancelled) setError(String(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pluginRefreshToken, pluginSettingsRepoId]);

  useEffect(() => {
    if (!selectedInstalledPlugin) {
      setConfig(null);
      setTopLevelDraft({});
      setChannelDrafts({});
      setConfigError(null);
      return;
    }

    let cancelled = false;
    setConfigLoading(true);
    setConfigError(null);
    loadPluginConfiguration(selectedInstalledPlugin.plugin_id, pluginSettingsRepoId ?? undefined)
      .then((result) => {
        if (cancelled) return;
        setConfig(result);
        setTopLevelDraft(result.top_level ? buildDraft(result.top_level) : {});
        const nextChannelDrafts: Record<string, DraftValues> = {};
        for (const channel of result.channels) {
          nextChannelDrafts[channel.server] = buildDraft(channel.section);
        }
        setChannelDrafts(nextChannelDrafts);
      })
      .catch((nextError) => {
        if (!cancelled) setConfigError(String(nextError));
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pluginSettingsRepoId, selectedInstalledPlugin]);

  async function refreshAffectedMcps(scope: EditablePluginScope | "managed" | null) {
    const repoIds = scope === "project" || scope === "local"
      ? pluginSettingsRepoId ? [pluginSettingsRepoId] : []
      : localRepositories.map((repo) => repo.id);

    await Promise.all(repoIds.map(async (repoId) => {
      try {
        const snapshot = await ensureAndValidateMcps(repoId);
        setMcpStatus(repoId, snapshot);
      } catch (nextError) {
        console.error(`Failed to refresh MCPs for ${repoId}:`, nextError);
      }
    }));
  }

  async function afterMutation(scope: EditablePluginScope | "managed" | null, nextMessage: string) {
    bumpPluginRefreshToken();
    await refreshAffectedMcps(scope);
    setMessage(nextMessage);
  }

  function requireRepoForScope(scope: EditablePluginScope): string | null {
    if (!scopeNeedsRepo(scope)) return null;
    return pluginSettingsRepoId;
  }

  async function withBusy(key: string, work: () => Promise<void>) {
    setBusyKey(key);
    setError(null);
    setMessage(null);
    try {
      await work();
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setBusyKey(null);
    }
  }

  function repoIdForPluginScope(scope: PluginScope): string | undefined {
    if (scope === "project" || scope === "local") {
      return pluginSettingsRepoId ?? undefined;
    }
    return undefined;
  }

  function openInstalledPlugin(pluginId: string) {
    setPluginSettingsTab("installed");
    setPluginFilter(pluginId);
    const matchingPlugins = installedPlugins.filter((plugin) => plugin.plugin_id === pluginId);
    const primaryScope = primaryInstalledScope(matchingPlugins.map((plugin) => plugin.scope));
    const targetPlugin = matchingPlugins.find((plugin) => plugin.scope === primaryScope)
      ?? matchingPlugins[0]
      ?? null;
    setSelectedPluginKey(targetPlugin ? installedPluginSelectionKey(targetPlugin) : null);
  }

  async function handleInstall(targetOverride?: string) {
    const target = (targetOverride ?? installTarget).trim();
    if (!target) {
      setError(t("ccp_error_enter_plugin_identifier"));
      return;
    }
    if (installScope !== "user") {
      const globalInstall = globallyInstalledPlugins.find((plugin) => matchesPluginTarget(plugin, target));
      if (globalInstall) {
        setError(
          t("ccp_error_already_installed_global", {
            id: globalInstall.plugin_id,
            scope: globalInstall.scope,
          }),
        );
        return;
      }
    }
    const repoId = requireRepoForScope(installScope);
    if (scopeNeedsRepo(installScope) && !repoId) {
      setError(t("ccp_error_select_local_repo"));
      return;
    }

    await withBusy(targetOverride ? `install:${target}` : "install", async () => {
      await installPlugin(target, installScope, repoId ?? undefined);
      await afterMutation(installScope, t("ccp_message_installed", { target, scope: installScope }));
      if (!targetOverride) {
        setInstallTarget("");
      }
      setPendingActionHint(null);
      setPendingTargetHint(null);
    });
  }

  async function handlePluginAction(
    plugin: InstalledPlugin,
    action: "enable" | "disable" | "uninstall" | "update",
  ) {
    const repoId = repoIdForPluginScope(plugin.scope);

    await withBusy(`${action}:${plugin.plugin_id}:${plugin.scope}`, async () => {
      if (action === "enable") {
        await enablePlugin(plugin.plugin_id, plugin.scope as EditablePluginScope, repoId);
      } else if (action === "disable") {
        await disablePlugin(plugin.plugin_id, plugin.scope as EditablePluginScope, repoId);
      } else if (action === "uninstall") {
        await uninstallPlugin(plugin.plugin_id, plugin.scope as EditablePluginScope, false, repoId);
        if (selectedPluginKey === installedPluginSelectionKey(plugin)) {
          setSelectedPluginKey(null);
        }
      } else {
        await updatePlugin(plugin.plugin_id, plugin.scope, repoId);
      }
      await afterMutation(plugin.scope, t(`ccp_message_action_${action}`, { id: plugin.plugin_id }));
      setPendingActionHint(null);
      setPendingTargetHint(null);
    });
  }

  async function handleUpdateAllInstalled() {
    await withBusy("update-all", async () => {
      const result = await updateAllPlugins(pluginSettingsRepoId ?? undefined);
      if (result.succeeded > 0) {
        const refreshScope = installedPlugins.some((plugin) => plugin.scope === "managed" || plugin.scope === "user")
          ? "user"
          : installedPlugins.some((plugin) => plugin.scope === "project")
            ? "project"
            : installedPlugins.some((plugin) => plugin.scope === "local")
              ? "local"
              : null;
        bumpPluginRefreshToken();
        await refreshAffectedMcps(refreshScope);
      }

      if (result.attempted === 0) {
        setMessage(t("ccp_message_no_updates_needed"));
      } else {
        setMessage(t("ccp_message_update_all_result", {
          plugins: t("ccp_count_plugin", { count: result.attempted }),
          updates: t("ccp_count_update", { count: result.succeeded }),
        }));
      }

      if (result.failed.length > 0) {
        const visibleFailures = result.failed.slice(0, 3).join("\n");
        const extraFailures = result.failed.length > 3
          ? `\n${t("ccp_failures_more", { count: result.failed.length - 3 })}`
          : "";
        setError(`${t("ccp_error_updates_failed")}\n${visibleFailures}${extraFailures}`);
      }

      setPendingActionHint(null);
      setPendingTargetHint(null);
    });
  }

  async function handleRefreshMarketplaceMetadata(messageText: string) {
    await withBusy("marketplace-refresh", async () => {
      await updatePluginMarketplace(undefined, pluginSettingsRepoId ?? undefined);
      bumpPluginRefreshToken();
      setMessage(messageText);
    });
  }

  async function handleMarketplaceAdd() {
    if (!marketplaceSource.trim()) {
      setError(t("ccp_error_enter_marketplace_source"));
      return;
    }
    const repoId = requireRepoForScope(marketplaceScope);
    if (scopeNeedsRepo(marketplaceScope) && !repoId) {
      setError(t("ccp_error_select_local_repo"));
      return;
    }
    await withBusy("marketplace-add", async () => {
      await addPluginMarketplace(marketplaceSource.trim(), marketplaceScope, repoId ?? undefined);
      bumpPluginRefreshToken();
      setMessage(t("ccp_message_marketplace_added", { source: marketplaceSource.trim() }));
      setPendingActionHint(null);
      setPendingTargetHint(null);
    });
  }

  async function handleSaveTopLevel() {
    const topLevelSection = config?.top_level;
    if (!topLevelSection || !selectedInstalledPlugin) return;
    await withBusy(`config:${selectedInstalledPlugin.plugin_id}:top`, async () => {
      await savePluginTopLevelConfiguration(
        selectedInstalledPlugin.plugin_id,
        buildPayload(topLevelSection, topLevelDraft),
        pluginSettingsRepoId ?? undefined,
      );
      await afterMutation("user", t("ccp_message_config_saved", { id: selectedInstalledPlugin.plugin_id }));
      const refreshed = await loadPluginConfiguration(
        selectedInstalledPlugin.plugin_id,
        pluginSettingsRepoId ?? undefined,
      );
      setConfig(refreshed);
      setTopLevelDraft(refreshed.top_level ? buildDraft(refreshed.top_level) : {});
    });
  }

  async function handleSaveChannel(serverName: string) {
    if (!config || !selectedInstalledPlugin) return;
    const channel = config.channels.find((entry) => entry.server === serverName);
    if (!channel) return;
    await withBusy(`config:${selectedInstalledPlugin.plugin_id}:${serverName}`, async () => {
      await savePluginChannelConfiguration(
        selectedInstalledPlugin.plugin_id,
        serverName,
        buildPayload(channel.section, channelDrafts[serverName] ?? {}),
        pluginSettingsRepoId ?? undefined,
      );
      await afterMutation("user", t("ccp_message_channel_config_saved", { server: serverName }));
      const refreshed = await loadPluginConfiguration(
        selectedInstalledPlugin.plugin_id,
        pluginSettingsRepoId ?? undefined,
      );
      setConfig(refreshed);
      const nextChannelDrafts: Record<string, DraftValues> = {};
      for (const entry of refreshed.channels) {
        nextChannelDrafts[entry.server] = buildDraft(entry.section);
      }
      setChannelDrafts(nextChannelDrafts);
    });
  }

  return (
    <div>
      <h1 className={styles.sectionTitle}>{t("nav_claude_code_plugins")}</h1>
      <div className={styles.settingDescription}>
        {t("ccp_intro")}
      </div>

      <div className={styles.pluginToolbar}>
        <div className={styles.inlineControl}>
          <label className={styles.settingLabel} htmlFor="plugin-repo-select">{t("ccp_repository_label")}</label>
          <select
            id="plugin-repo-select"
            className={styles.select}
            value={pluginSettingsRepoId ?? ""}
            onChange={(event) => setPluginSettingsRepoId(event.target.value || null)}
          >
            <option value="">{t("ccp_global_only")}</option>
            {localRepositories.map((repo) => (
              <option key={repo.id} value={repo.id}>{repo.name}</option>
            ))}
          </select>
        </div>

        <div className={styles.pluginTabs}>
          <button
            className={pluginSettingsTab === "available" ? styles.pluginTabActive : styles.pluginTab}
            onClick={() => setPluginSettingsTab("available")}
          >
            {t("ccp_tab_available")}
          </button>
          <button
            className={pluginSettingsTab === "installed" ? styles.pluginTabActive : styles.pluginTab}
            onClick={() => setPluginSettingsTab("installed")}
          >
            {t("ccp_tab_installed")}
          </button>
          <button
            className={pluginSettingsTab === "marketplaces" ? styles.pluginTabActive : styles.pluginTab}
            onClick={() => setPluginSettingsTab("marketplaces")}
          >
            {t("ccp_tab_marketplaces")}
          </button>
        </div>
      </div>

      {pendingActionHint && pendingTargetHint && (
        <div className={styles.pluginNotice}>
          <Trans
            i18nKey="ccp_pending_action"
            ns="settings"
            values={{ action: pendingActionHint, target: pendingTargetHint }}
            components={{ strong: <strong />, code: <code /> }}
          />
        </div>
      )}
      {message && <div className={styles.pluginSuccess}>{message}</div>}
      {error && <div className={styles.pluginError}>{error}</div>}

      {pluginSettingsTab === "available" && (
        <div className={styles.pluginPanel}>
          <div className={styles.pluginSummaryGrid}>
            <PluginStatCard
              label={t("ccp_stat_marketplace_catalog")}
              value={String(availableSummary.total)}
              detail={t("ccp_count_marketplace", { count: marketplaces.length })}
            />
            <PluginStatCard
              label={t("ccp_stat_ready_to_install")}
              value={String(availableSummary.discoverable)}
              detail={t("ccp_stat_not_installed_here")}
            />
            <PluginStatCard
              label={t("ccp_stat_installed_here")}
              value={String(availableSummary.installed)}
              detail={t("ccp_count_distinct_plugin", { count: installedSummary.pluginCount })}
            />
            <PluginStatCard
              label={t("ccp_stat_known_updates")}
              value={String(installedSummary.updatesAvailable)}
              detail={installedSummary.unknownVersionCount > 0
                ? t("ccp_stat_unknown_version_detail", { count: installedSummary.unknownVersionCount })
                : t("ccp_stat_all_versioned")}
            />
          </div>

          <div className={styles.pluginInlineNote}>
            {t("ccp_available_note")}
          </div>

          <div className={styles.pluginFormRow}>
            <input
              className={styles.input}
              placeholder={t("ccp_search_placeholder")}
              value={availableFilter}
              onChange={(event) => setAvailableFilter(event.target.value)}
            />
            <select
              className={styles.select}
              value={installScope}
              onChange={(event) => setInstallScope(event.target.value as EditablePluginScope)}
            >
              <option value="user">{t("ccp_install_to_user")}</option>
              <option value="project">{t("ccp_install_to_project")}</option>
              <option value="local">{t("ccp_install_to_local")}</option>
            </select>
            <button
              className={styles.iconBtn}
              onClick={() => void handleRefreshMarketplaceMetadata(t("ccp_message_marketplaces_refreshed"))}
              disabled={busyKey === "marketplace-refresh"}
            >
              {t("ccp_refresh_marketplaces")}
            </button>
          </div>

          <div className={styles.pluginFormRow}>
            <input
              className={styles.input}
              placeholder={t("ccp_install_target_placeholder")}
              value={installTarget}
              onChange={(event) => setInstallTarget(event.target.value)}
            />
            <button className={styles.iconBtn} onClick={() => void handleInstall()} disabled={busyKey === "install"}>
              {t("ccp_install")}
            </button>
          </div>

          {loading ? (
            <div className={styles.settingDescription}>{t("ccp_loading_catalog")}</div>
          ) : filteredAvailable.length === 0 ? (
            <div className={styles.settingDescription}>{t("ccp_no_available_match")}</div>
          ) : (
            <div className={styles.pluginList}>
              {filteredAvailable.map((plugin) => {
                const installableAtScope = canInstallAvailablePluginAtScope(plugin, installScope);
                const installCount = formatInstallCount(plugin.install_count);
                const links = availablePluginLinks(plugin);
                return (
                  <div key={plugin.plugin_id} className={styles.pluginCard}>
                    <div className={styles.pluginCardHeader}>
                      <div className={styles.pluginCardBody}>
                        <div className={styles.pluginCardTitle}>
                          <span>{plugin.name}</span>
                          <span className={styles.pluginBadge}>{plugin.marketplace}</span>
                          {plugin.category && <span className={styles.pluginBadge}>{plugin.category}</span>}
                          {plugin.version && <span className={styles.pluginBadge}>v{plugin.version}</span>}
                          {plugin.installed && <span className={styles.pluginBadge}>{t("ccp_badge_installed")}</span>}
                          {plugin.enabled && <span className={styles.pluginBadge}>{t("ccp_badge_enabled")}</span>}
                          {plugin.update_available && <span className={styles.pluginBadge}>{t("ccp_badge_update_available")}</span>}
                          {plugin.installed_scopes.map((scope) => (
                            <span key={`${plugin.plugin_id}:${scope}`} className={styles.pluginBadge}>
                              {scope}
                            </span>
                          ))}
                        </div>
                        <div className={styles.settingDescription}>
                          {plugin.description ?? t("ccp_no_description")}
                        </div>
                        {installCount && (
                          <div className={styles.pluginMeta}>{installCount}</div>
                        )}
                        {links.length > 0 && (
                          <div className={styles.pluginLinkRow}>
                            {links.map((link) => (
                              <ExternalBrowserLink
                                key={`${plugin.plugin_id}:${link.label}:${link.url}`}
                                detail={link.detail}
                                href={link.url}
                                label={link.label}
                                meta={link.meta}
                              />
                            ))}
                          </div>
                        )}
                      </div>

                      <div className={styles.pluginActions}>
                        {plugin.installed && (
                          <button
                            className={styles.iconBtn}
                            onClick={() => openInstalledPlugin(plugin.plugin_id)}
                          >
                            {t("ccp_manage")}
                          </button>
                        )}
                        {installableAtScope && (
                          <button
                            className={styles.iconBtn}
                            onClick={() => void handleInstall(plugin.plugin_id)}
                            disabled={
                              (scopeNeedsRepo(installScope) && !pluginSettingsRepoId)
                              || busyKey === `install:${plugin.plugin_id}`
                            }
                          >
                            {t("ccp_install_to_scope", { scope: installScope })}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {pluginSettingsTab === "installed" && (
        <div className={styles.pluginPanel}>
          <div className={styles.pluginSummaryGrid}>
            <PluginStatCard
              label={t("ccp_stat_installations")}
              value={String(installedSummary.installationCount)}
              detail={t("ccp_count_distinct_plugin", { count: installedSummary.pluginCount })}
            />
            <PluginStatCard
              label={t("ccp_stat_known_updates")}
              value={String(installedSummary.updatesAvailable)}
              detail={t("ccp_stat_based_on_versions")}
            />
            <PluginStatCard
              label={t("ccp_stat_unknown_version_status")}
              value={String(installedSummary.unknownVersionCount)}
              detail={t("ccp_stat_still_work_update_all")}
            />
            <PluginStatCard
              label={t("ccp_stat_configured_marketplaces")}
              value={String(marketplaces.length)}
              detail={t("ccp_stat_refresh_to_check")}
            />
          </div>

          <div className={styles.pluginInlineNote}>
            {t("ccp_installed_note")}
          </div>

          <div className={styles.pluginFormRow}>
            <input
              className={styles.input}
              placeholder={t("ccp_filter_installed_placeholder")}
              value={pluginFilter}
              onChange={(event) => setPluginFilter(event.target.value)}
            />
            <button
              className={styles.iconBtn}
              onClick={() => void handleUpdateAllInstalled()}
              disabled={busyKey === "update-all"}
            >
              {t("ccp_update_all")}
            </button>
            <button
              className={styles.iconBtn}
              onClick={() => void handleRefreshMarketplaceMetadata(t("ccp_message_marketplaces_refreshed_for_updates"))}
              disabled={busyKey === "marketplace-refresh"}
            >
              {t("ccp_refresh_marketplaces")}
            </button>
          </div>

          {loading ? (
            <div className={styles.settingDescription}>{t("ccp_loading_installed")}</div>
          ) : filteredInstalled.length === 0 ? (
            <div className={styles.settingDescription}>{t("ccp_no_installed_match")}</div>
          ) : (
            <div className={styles.pluginList}>
              {filteredInstalled.map((plugin) => {
                const catalogPlugin = availablePluginsById.get(plugin.plugin_id);
                const links = catalogPlugin ? availablePluginLinks(catalogPlugin) : [];
                return (
                  <div
                    key={`${plugin.plugin_id}:${plugin.scope}`}
                    className={`${styles.pluginCard}${selectedPluginKey === installedPluginSelectionKey(plugin) ? ` ${styles.pluginCardSelected}` : ""}`}
                  >
                    <div className={styles.pluginCardHeader}>
                      <div className={styles.pluginCardBody}>
                        <div className={styles.pluginCardTitle}>
                          <span>{plugin.plugin_id}</span>
                          <span className={styles.pluginBadge}>{plugin.scope}</span>
                          <span className={styles.pluginBadge}>{plugin.enabled ? t("ccp_badge_enabled") : t("ccp_badge_disabled")}</span>
                          {plugin.update_available && plugin.latest_known_version && (
                            <span className={styles.pluginBadge}>{t("ccp_badge_update_to", { version: plugin.latest_known_version })}</span>
                          )}
                          {plugin.command_count > 0 && <span className={styles.pluginBadge}>{t("ccp_badge_commands", { count: plugin.command_count })}</span>}
                          {plugin.skill_count > 0 && <span className={styles.pluginBadge}>{t("ccp_badge_skills", { count: plugin.skill_count })}</span>}
                          {plugin.mcp_servers.length > 0 && <span className={styles.pluginBadge}>{t("ccp_badge_mcp", { count: plugin.mcp_servers.length })}</span>}
                        </div>
                        <div className={styles.settingDescription}>
                          {plugin.description ?? t("ccp_no_description")}
                        </div>
                        <div className={styles.pluginMeta}>
                          {[
                            `v${plugin.version}`,
                            plugin.latest_known_version && !plugin.update_available
                              ? t("ccp_meta_latest", { version: plugin.latest_known_version })
                              : null,
                            repoAvailabilityDetail(t, plugin.scope, pluginSettingsRepoId !== null),
                            plugin.install_path,
                          ].filter((value): value is string => Boolean(value)).join(" · ")}
                        </div>
                        {links.length > 0 && (
                          <div className={styles.pluginLinkRow}>
                            {links.map((link) => (
                              <ExternalBrowserLink
                                key={`${plugin.plugin_id}:${plugin.scope}:${link.label}:${link.url}`}
                                detail={link.detail}
                                href={link.url}
                                label={link.label}
                                meta={link.meta}
                              />
                            ))}
                          </div>
                        )}
                      </div>

                      <div className={styles.pluginActions}>
                        {plugin.scope !== "managed" && (
                          plugin.enabled ? (
                            <button
                              className={styles.iconBtn}
                              onClick={() => void handlePluginAction(plugin, "disable")}
                              disabled={busyKey === `disable:${plugin.plugin_id}:${plugin.scope}`}
                            >
                              {t("ccp_disable")}
                            </button>
                          ) : (
                            <button
                              className={styles.iconBtn}
                              onClick={() => void handlePluginAction(plugin, "enable")}
                              disabled={busyKey === `enable:${plugin.plugin_id}:${plugin.scope}`}
                            >
                              {t("ccp_enable")}
                            </button>
                          )
                        )}
                        <button
                          className={styles.iconBtn}
                          onClick={() => void handlePluginAction(plugin, "update")}
                          disabled={busyKey === `update:${plugin.plugin_id}:${plugin.scope}`}
                        >
                          {t("ccp_update")}
                        </button>
                        {plugin.scope !== "managed" && (
                          <button
                            className={styles.iconBtn}
                            onClick={() => void handlePluginAction(plugin, "uninstall")}
                            disabled={busyKey === `uninstall:${plugin.plugin_id}:${plugin.scope}`}
                          >
                            {t("ccp_uninstall")}
                          </button>
                        )}
                        {hasConfig(plugin) && (
                          <button
                            className={styles.iconBtn}
                            onClick={() => setSelectedPluginKey((current) =>
                              current === installedPluginSelectionKey(plugin)
                                ? null
                                : installedPluginSelectionKey(plugin)
                            )}
                          >
                            {t("ccp_configure")}
                          </button>
                        )}
                      </div>
                    </div>

                    {selectedPluginKey === installedPluginSelectionKey(plugin) && (
                      <div className={styles.pluginConfigPanel}>
                        {configLoading ? (
                          <div className={styles.settingDescription}>{t("ccp_loading_configuration")}</div>
                        ) : configError ? (
                          <div className={styles.pluginError}>{configError}</div>
                        ) : config ? (
                          <>
                            {config.top_level && (
                              <ConfigEditor
                                title={t("ccp_plugin_options")}
                                section={config.top_level}
                                draft={topLevelDraft}
                                onDraftChange={(key, value) => setTopLevelDraft((draft) => ({ ...draft, [key]: value }))}
                                onSave={() => void handleSaveTopLevel()}
                                busy={busyKey === `config:${plugin.plugin_id}:top`}
                              />
                            )}
                            {config.channels.map((channel) => (
                              <ConfigEditor
                                key={channel.server}
                                title={channel.display_name ?? channel.server}
                                section={channel.section}
                                draft={channelDrafts[channel.server] ?? {}}
                                onDraftChange={(key, value) => setChannelDrafts((drafts) => ({
                                  ...drafts,
                                  [channel.server]: {
                                    ...drafts[channel.server],
                                    [key]: value,
                                  },
                                }))}
                                onSave={() => void handleSaveChannel(channel.server)}
                                busy={busyKey === `config:${plugin.plugin_id}:${channel.server}`}
                              />
                            ))}
                            {!config.top_level && config.channels.length === 0 && (
                              <div className={styles.settingDescription}>{t("ccp_no_configurable_fields")}</div>
                            )}
                          </>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {pluginSettingsTab === "marketplaces" && (
        <div className={styles.pluginPanel}>
          <div className={styles.pluginSummaryGrid}>
            <PluginStatCard
              label={t("ccp_stat_configured_marketplaces")}
              value={String(marketplaces.length)}
              detail={t("ccp_stat_visible_in_repo")}
            />
            <PluginStatCard
              label={t("ccp_stat_catalog_entries")}
              value={String(availableSummary.total)}
              detail={t("ccp_stat_local_clones")}
            />
            <PluginStatCard
              label={t("ccp_stat_known_plugin_updates")}
              value={String(installedSummary.updatesAvailable)}
              detail={t("ccp_stat_recomputed")}
            />
            <PluginStatCard
              label={t("ccp_stat_direct_installs")}
              value={String(availableSummary.discoverable)}
              detail={t("ccp_stat_not_yet_installed")}
            />
          </div>

          <div className={styles.pluginInlineNote}>
            {t("ccp_marketplaces_note")}
          </div>

          <div className={styles.pluginFormRow}>
            <input
              className={styles.input}
              placeholder={t("ccp_marketplace_source_placeholder")}
              value={marketplaceSource}
              onChange={(event) => setMarketplaceSource(event.target.value)}
            />
            <select
              className={styles.select}
              value={marketplaceScope}
              onChange={(event) => setMarketplaceScope(event.target.value as EditablePluginScope)}
            >
              <option value="user">{t("ccp_scope_user")}</option>
              <option value="project">{t("ccp_scope_project")}</option>
              <option value="local">{t("ccp_scope_local")}</option>
            </select>
            <button className={styles.iconBtn} onClick={() => void handleMarketplaceAdd()} disabled={busyKey === "marketplace-add"}>
              {t("ccp_add")}
            </button>
            <button
              className={styles.iconBtn}
              onClick={() => void handleRefreshMarketplaceMetadata(t("ccp_message_all_marketplaces_updated"))}
              disabled={busyKey === "marketplace-refresh"}
            >
              {t("ccp_update_all")}
            </button>
          </div>

          <div className={styles.pluginFormRow}>
            <input
              className={styles.input}
              placeholder={t("ccp_filter_marketplaces_placeholder")}
              value={marketplaceFilter}
              onChange={(event) => setMarketplaceFilter(event.target.value)}
            />
          </div>

          {loading ? (
            <div className={styles.settingDescription}>{t("ccp_loading_marketplaces")}</div>
          ) : filteredMarketplaces.length === 0 ? (
            <div className={styles.settingDescription}>{t("ccp_no_marketplaces_match")}</div>
          ) : (
            <div className={styles.pluginList}>
              {filteredMarketplaces.map((marketplace) => {
                const sourceLink = marketplaceSourceLink(marketplace);
                return (
                  <div key={marketplace.name} className={styles.pluginCard}>
                    <div className={styles.pluginCardHeader}>
                      <div className={styles.pluginCardBody}>
                        <div className={styles.pluginCardTitle}>
                          <span>{marketplace.name}</span>
                          {marketplace.scope && <span className={styles.pluginBadge}>{marketplace.scope}</span>}
                          <span className={styles.pluginBadge}>{marketplace.source_kind}</span>
                        </div>
                        <div className={styles.settingDescription}>
                          {sourceLink ? t("ccp_marketplace_source_kind", { kind: marketplace.source_kind }) : marketplace.source_label}
                        </div>
                        {sourceLink && (
                          <div className={styles.pluginLinkRow}>
                            <ExternalBrowserLink
                              detail={sourceLink.detail}
                              href={sourceLink.url}
                              label={sourceLink.label}
                              meta={sourceLink.meta}
                            />
                          </div>
                        )}
                        {marketplace.install_location && (
                          <div className={styles.pluginMeta}>{marketplace.install_location}</div>
                        )}
                      </div>
                      <div className={styles.pluginActions}>
                        <button
                          className={styles.iconBtn}
                          onClick={() => void withBusy(`marketplace-update:${marketplace.name}`, async () => {
                            await updatePluginMarketplace(marketplace.name, pluginSettingsRepoId ?? undefined);
                            bumpPluginRefreshToken();
                            setMessage(t("ccp_message_marketplace_updated", { name: marketplace.name }));
                          })}
                          disabled={busyKey === `marketplace-update:${marketplace.name}`}
                        >
                          {t("ccp_update")}
                        </button>
                        <button
                          className={styles.iconBtn}
                          onClick={() => void withBusy(`marketplace-remove:${marketplace.name}`, async () => {
                            await removePluginMarketplace(marketplace.name, pluginSettingsRepoId ?? undefined);
                            bumpPluginRefreshToken();
                            setMessage(t("ccp_message_marketplace_removed", { name: marketplace.name }));
                            setPendingActionHint(null);
                            setPendingTargetHint(null);
                          })}
                          disabled={busyKey === `marketplace-remove:${marketplace.name}`}
                        >
                          {t("ccp_remove")}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
