import { useEffect, useMemo, useState } from "react";

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

function repoAvailabilityDetail(scope: PluginScope, hasRepoContext: boolean): string | null {
  if (!hasRepoContext) return null;
  if (scope === "user" || scope === "managed") {
    return `available in this repo via ${scope} scope`;
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

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
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
  return (
    <div className={styles.pluginConfigSection}>
      <div className={styles.pluginConfigHeader}>
        <div>
          <div className={styles.settingLabel}>{title}</div>
          <div className={styles.settingDescription}>
            Sensitive fields are masked and blank values keep the existing secret.
          </div>
        </div>
        <button className={styles.iconBtn} onClick={onSave} disabled={busy}>
          Save
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
                  placeholder={field.sensitive && savedSensitive ? "Saved" : ""}
                />
              ) : (
                <input
                  className={styles.input}
                  type={field.sensitive ? "password" : field.type === "number" ? "number" : "text"}
                  min={field.min ?? undefined}
                  max={field.max ?? undefined}
                  value={String(draft[key] ?? "")}
                  onChange={(event) => onDraftChange(key, event.target.value)}
                  placeholder={field.sensitive && savedSensitive ? "Saved" : ""}
                />
              )}
              <span className={styles.pluginFieldMeta}>
                {field.required ? "Required" : "Optional"}
                {field.sensitive ? " · Sensitive" : ""}
                {savedSensitive && field.sensitive ? " · Secret saved" : ""}
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

export function PluginsSettings() {
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
      setError("Enter a plugin identifier to install.");
      return;
    }
    if (installScope !== "user") {
      const globalInstall = globallyInstalledPlugins.find((plugin) => matchesPluginTarget(plugin, target));
      if (globalInstall) {
        setError(
          `${globalInstall.plugin_id} is already installed at ${globalInstall.scope} scope and is already available in this repository.`,
        );
        return;
      }
    }
    const repoId = requireRepoForScope(installScope);
    if (scopeNeedsRepo(installScope) && !repoId) {
      setError("Select a local repository for project/local scope.");
      return;
    }

    await withBusy(targetOverride ? `install:${target}` : "install", async () => {
      await installPlugin(target, installScope, repoId ?? undefined);
      await afterMutation(installScope, `Installed ${target} at ${installScope} scope.`);
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
      await afterMutation(plugin.scope, `${action} completed for ${plugin.plugin_id}.`);
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
        setMessage("No plugins need update checks in this context.");
      } else {
        setMessage(`Checked ${pluralize(result.attempted, "plugin")}; ${pluralize(result.succeeded, "update")} completed.`);
      }

      if (result.failed.length > 0) {
        const visibleFailures = result.failed.slice(0, 3).join("\n");
        const extraFailures = result.failed.length > 3
          ? `\n… ${result.failed.length - 3} more`
          : "";
        setError(`Some plugin updates failed:\n${visibleFailures}${extraFailures}`);
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
      setError("Enter a marketplace source.");
      return;
    }
    const repoId = requireRepoForScope(marketplaceScope);
    if (scopeNeedsRepo(marketplaceScope) && !repoId) {
      setError("Select a local repository for project/local scope.");
      return;
    }
    await withBusy("marketplace-add", async () => {
      await addPluginMarketplace(marketplaceSource.trim(), marketplaceScope, repoId ?? undefined);
      bumpPluginRefreshToken();
      setMessage(`Added marketplace ${marketplaceSource.trim()}.`);
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
      await afterMutation("user", `Saved configuration for ${selectedInstalledPlugin.plugin_id}.`);
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
      await afterMutation("user", `Saved ${serverName} configuration.`);
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
      <h1 className={styles.sectionTitle}>Plugins</h1>
      <div className={styles.settingDescription}>
        Browse marketplace plugins, manage installed ones, and refresh marketplace metadata using the real Claude CLI.
      </div>

      <div className={styles.pluginToolbar}>
        <div className={styles.inlineControl}>
          <label className={styles.settingLabel} htmlFor="plugin-repo-select">Repository</label>
          <select
            id="plugin-repo-select"
            className={styles.select}
            value={pluginSettingsRepoId ?? ""}
            onChange={(event) => setPluginSettingsRepoId(event.target.value || null)}
          >
            <option value="">Global only</option>
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
            Available
          </button>
          <button
            className={pluginSettingsTab === "installed" ? styles.pluginTabActive : styles.pluginTab}
            onClick={() => setPluginSettingsTab("installed")}
          >
            Installed
          </button>
          <button
            className={pluginSettingsTab === "marketplaces" ? styles.pluginTabActive : styles.pluginTab}
            onClick={() => setPluginSettingsTab("marketplaces")}
          >
            Marketplaces
          </button>
        </div>
      </div>

      {pendingActionHint && pendingTargetHint && (
        <div className={styles.pluginNotice}>
          Pending action: <strong>{pendingActionHint}</strong> for <code>{pendingTargetHint}</code>.
        </div>
      )}
      {message && <div className={styles.pluginSuccess}>{message}</div>}
      {error && <div className={styles.pluginError}>{error}</div>}

      {pluginSettingsTab === "available" && (
        <div className={styles.pluginPanel}>
          <div className={styles.pluginSummaryGrid}>
            <PluginStatCard
              label="Marketplace catalog"
              value={String(availableSummary.total)}
              detail={pluralize(marketplaces.length, "marketplace")}
            />
            <PluginStatCard
              label="Ready to install"
              value={String(availableSummary.discoverable)}
              detail="Not installed in this context"
            />
            <PluginStatCard
              label="Installed here"
              value={String(availableSummary.installed)}
              detail={pluralize(installedSummary.pluginCount, "distinct plugin")}
            />
            <PluginStatCard
              label="Known updates"
              value={String(installedSummary.updatesAvailable)}
              detail={installedSummary.unknownVersionCount > 0
                ? `${pluralize(installedSummary.unknownVersionCount, "plugin")} without version metadata`
                : "All installed plugins publish version metadata"}
            />
          </div>

          <div className={styles.pluginInlineNote}>
            Claude Code treats user and managed installs as global, so this browser does not offer redundant project or local installs for plugins that are already available everywhere. Refresh marketplaces to recalculate update badges.
          </div>

          <div className={styles.pluginFormRow}>
            <input
              className={styles.input}
              placeholder="Search marketplace plugins"
              value={availableFilter}
              onChange={(event) => setAvailableFilter(event.target.value)}
            />
            <select
              className={styles.select}
              value={installScope}
              onChange={(event) => setInstallScope(event.target.value as EditablePluginScope)}
            >
              <option value="user">Install to user</option>
              <option value="project">Install to project</option>
              <option value="local">Install to local</option>
            </select>
            <button
              className={styles.iconBtn}
              onClick={() => void handleRefreshMarketplaceMetadata("Refreshed marketplace metadata.")}
              disabled={busyKey === "marketplace-refresh"}
            >
              Refresh Marketplaces
            </button>
          </div>

          <div className={styles.pluginFormRow}>
            <input
              className={styles.input}
              placeholder="Install custom plugin target or plugin@marketplace"
              value={installTarget}
              onChange={(event) => setInstallTarget(event.target.value)}
            />
            <button className={styles.iconBtn} onClick={() => void handleInstall()} disabled={busyKey === "install"}>
              Install
            </button>
          </div>

          {loading ? (
            <div className={styles.settingDescription}>Loading plugin catalog…</div>
          ) : filteredAvailable.length === 0 ? (
            <div className={styles.settingDescription}>No marketplace plugins match this view.</div>
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
                          {plugin.installed && <span className={styles.pluginBadge}>installed</span>}
                          {plugin.enabled && <span className={styles.pluginBadge}>enabled</span>}
                          {plugin.update_available && <span className={styles.pluginBadge}>update available</span>}
                          {plugin.installed_scopes.map((scope) => (
                            <span key={`${plugin.plugin_id}:${scope}`} className={styles.pluginBadge}>
                              {scope}
                            </span>
                          ))}
                        </div>
                        <div className={styles.settingDescription}>
                          {plugin.description ?? "No description provided."}
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
                            Manage
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
                            Install to {installScope}
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
              label="Installations"
              value={String(installedSummary.installationCount)}
              detail={pluralize(installedSummary.pluginCount, "distinct plugin")}
            />
            <PluginStatCard
              label="Known updates"
              value={String(installedSummary.updatesAvailable)}
              detail="Based on refreshed marketplace versions"
            />
            <PluginStatCard
              label="Unknown version status"
              value={String(installedSummary.unknownVersionCount)}
              detail="These still work with Update All"
            />
            <PluginStatCard
              label="Configured marketplaces"
              value={String(marketplaces.length)}
              detail="Refresh them to check for new versions"
            />
          </div>

          <div className={styles.pluginInlineNote}>
            Claude Code’s interactive plugin tools do not expose a native one-shot update-all command. Claudette now runs the per-plugin update flow across this installed set and surfaces concrete update badges when metadata is available.
          </div>

          <div className={styles.pluginFormRow}>
            <input
              className={styles.input}
              placeholder="Filter installed plugins"
              value={pluginFilter}
              onChange={(event) => setPluginFilter(event.target.value)}
            />
            <button
              className={styles.iconBtn}
              onClick={() => void handleUpdateAllInstalled()}
              disabled={busyKey === "update-all"}
            >
              Update All
            </button>
            <button
              className={styles.iconBtn}
              onClick={() => void handleRefreshMarketplaceMetadata("Refreshed marketplace metadata for update checks.")}
              disabled={busyKey === "marketplace-refresh"}
            >
              Refresh Marketplaces
            </button>
          </div>

          {loading ? (
            <div className={styles.settingDescription}>Loading installed plugins…</div>
          ) : filteredInstalled.length === 0 ? (
            <div className={styles.settingDescription}>No installed plugins match this view.</div>
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
                          <span className={styles.pluginBadge}>{plugin.enabled ? "enabled" : "disabled"}</span>
                          {plugin.update_available && plugin.latest_known_version && (
                            <span className={styles.pluginBadge}>update → v{plugin.latest_known_version}</span>
                          )}
                          {plugin.command_count > 0 && <span className={styles.pluginBadge}>{plugin.command_count} cmds</span>}
                          {plugin.skill_count > 0 && <span className={styles.pluginBadge}>{plugin.skill_count} skills</span>}
                          {plugin.mcp_servers.length > 0 && <span className={styles.pluginBadge}>{plugin.mcp_servers.length} mcp</span>}
                        </div>
                        <div className={styles.settingDescription}>
                          {plugin.description ?? "No description provided."}
                        </div>
                        <div className={styles.pluginMeta}>
                          {[
                            `v${plugin.version}`,
                            plugin.latest_known_version && !plugin.update_available
                              ? `latest v${plugin.latest_known_version}`
                              : null,
                            repoAvailabilityDetail(plugin.scope, pluginSettingsRepoId !== null),
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
                              Disable
                            </button>
                          ) : (
                            <button
                              className={styles.iconBtn}
                              onClick={() => void handlePluginAction(plugin, "enable")}
                              disabled={busyKey === `enable:${plugin.plugin_id}:${plugin.scope}`}
                            >
                              Enable
                            </button>
                          )
                        )}
                        <button
                          className={styles.iconBtn}
                          onClick={() => void handlePluginAction(plugin, "update")}
                          disabled={busyKey === `update:${plugin.plugin_id}:${plugin.scope}`}
                        >
                          Update
                        </button>
                        {plugin.scope !== "managed" && (
                          <button
                            className={styles.iconBtn}
                            onClick={() => void handlePluginAction(plugin, "uninstall")}
                            disabled={busyKey === `uninstall:${plugin.plugin_id}:${plugin.scope}`}
                          >
                            Uninstall
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
                            Configure
                          </button>
                        )}
                      </div>
                    </div>

                    {selectedPluginKey === installedPluginSelectionKey(plugin) && (
                      <div className={styles.pluginConfigPanel}>
                        {configLoading ? (
                          <div className={styles.settingDescription}>Loading configuration…</div>
                        ) : configError ? (
                          <div className={styles.pluginError}>{configError}</div>
                        ) : config ? (
                          <>
                            {config.top_level && (
                              <ConfigEditor
                                title="Plugin options"
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
                              <div className={styles.settingDescription}>This plugin does not expose configurable fields.</div>
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
              label="Configured marketplaces"
              value={String(marketplaces.length)}
              detail="Visible in this repo context"
            />
            <PluginStatCard
              label="Catalog entries"
              value={String(availableSummary.total)}
              detail="Powered by local marketplace clones"
            />
            <PluginStatCard
              label="Known plugin updates"
              value={String(installedSummary.updatesAvailable)}
              detail="Recomputed after marketplace refresh"
            />
            <PluginStatCard
              label="Direct installs"
              value={String(availableSummary.discoverable)}
              detail="Plugins not yet installed here"
            />
          </div>

          <div className={styles.pluginInlineNote}>
            Refreshing marketplaces updates the available-plugin catalog and the version metadata used for per-plugin update badges.
          </div>

          <div className={styles.pluginFormRow}>
            <input
              className={styles.input}
              placeholder="github:owner/repo, URL, or local path"
              value={marketplaceSource}
              onChange={(event) => setMarketplaceSource(event.target.value)}
            />
            <select
              className={styles.select}
              value={marketplaceScope}
              onChange={(event) => setMarketplaceScope(event.target.value as EditablePluginScope)}
            >
              <option value="user">User</option>
              <option value="project">Project</option>
              <option value="local">Local</option>
            </select>
            <button className={styles.iconBtn} onClick={() => void handleMarketplaceAdd()} disabled={busyKey === "marketplace-add"}>
              Add
            </button>
            <button
              className={styles.iconBtn}
              onClick={() => void handleRefreshMarketplaceMetadata("Updated all marketplaces.")}
              disabled={busyKey === "marketplace-refresh"}
            >
              Update All
            </button>
          </div>

          <div className={styles.pluginFormRow}>
            <input
              className={styles.input}
              placeholder="Filter marketplaces"
              value={marketplaceFilter}
              onChange={(event) => setMarketplaceFilter(event.target.value)}
            />
          </div>

          {loading ? (
            <div className={styles.settingDescription}>Loading marketplaces…</div>
          ) : filteredMarketplaces.length === 0 ? (
            <div className={styles.settingDescription}>No marketplaces match this view.</div>
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
                          {sourceLink ? `${marketplace.source_kind} marketplace source` : marketplace.source_label}
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
                            setMessage(`Updated ${marketplace.name}.`);
                          })}
                          disabled={busyKey === `marketplace-update:${marketplace.name}`}
                        >
                          Update
                        </button>
                        <button
                          className={styles.iconBtn}
                          onClick={() => void withBusy(`marketplace-remove:${marketplace.name}`, async () => {
                            await removePluginMarketplace(marketplace.name, pluginSettingsRepoId ?? undefined);
                            bumpPluginRefreshToken();
                            setMessage(`Removed ${marketplace.name}.`);
                            setPendingActionHint(null);
                            setPendingTargetHint(null);
                          })}
                          disabled={busyKey === `marketplace-remove:${marketplace.name}`}
                        >
                          Remove
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
