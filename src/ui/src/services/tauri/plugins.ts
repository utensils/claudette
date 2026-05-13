import { invoke } from "@tauri-apps/api/core";
import type {
  BulkPluginUpdateResult,
  EditablePluginScope,
  InstalledPlugin,
  PluginCatalog,
  PluginConfiguration,
  PluginMarketplace,
} from "../../types/plugins";

export function listPlugins(
  repoId?: string,
): Promise<InstalledPlugin[]> {
  return invoke("list_plugins", { repoId: repoId ?? null });
}

export function listPluginCatalog(
  repoId?: string,
): Promise<PluginCatalog> {
  return invoke("list_plugin_catalog", { repoId: repoId ?? null });
}

export function listPluginMarketplaces(
  repoId?: string,
): Promise<PluginMarketplace[]> {
  return invoke("list_plugin_marketplaces", { repoId: repoId ?? null });
}

export function installPlugin(
  target: string,
  scope: EditablePluginScope,
  repoId?: string,
): Promise<string> {
  return invoke("install_plugin", {
    target,
    scope,
    repoId: repoId ?? null,
  });
}

export function uninstallPlugin(
  pluginId: string,
  scope: EditablePluginScope,
  keepData: boolean,
  repoId?: string,
): Promise<string> {
  return invoke("uninstall_plugin", {
    pluginId,
    scope,
    keepData,
    repoId: repoId ?? null,
  });
}

export function enablePlugin(
  pluginId: string,
  scope: EditablePluginScope,
  repoId?: string,
): Promise<string> {
  return invoke("enable_plugin", {
    pluginId,
    scope,
    repoId: repoId ?? null,
  });
}

export function disablePlugin(
  pluginId: string,
  scope: EditablePluginScope,
  repoId?: string,
): Promise<string> {
  return invoke("disable_plugin", {
    pluginId,
    scope,
    repoId: repoId ?? null,
  });
}

export function updatePlugin(
  pluginId: string,
  scope: EditablePluginScope | "managed",
  repoId?: string,
): Promise<string> {
  return invoke("update_plugin", {
    pluginId,
    scope,
    repoId: repoId ?? null,
  });
}

export function updateAllPlugins(
  repoId?: string,
): Promise<BulkPluginUpdateResult> {
  return invoke("update_all_plugins", {
    repoId: repoId ?? null,
  });
}

export function addPluginMarketplace(
  source: string,
  scope: EditablePluginScope,
  repoId?: string,
): Promise<string> {
  return invoke("add_plugin_marketplace", {
    source,
    scope,
    repoId: repoId ?? null,
  });
}

export function removePluginMarketplace(
  name: string,
  repoId?: string,
): Promise<string> {
  return invoke("remove_plugin_marketplace", {
    name,
    repoId: repoId ?? null,
  });
}

export function updatePluginMarketplace(
  name?: string,
  repoId?: string,
): Promise<string> {
  return invoke("update_plugin_marketplace", {
    name: name ?? null,
    repoId: repoId ?? null,
  });
}

export function loadPluginConfiguration(
  pluginId: string,
  repoId?: string,
): Promise<PluginConfiguration> {
  return invoke("load_plugin_configuration", {
    pluginId,
    repoId: repoId ?? null,
  });
}

export function savePluginTopLevelConfiguration(
  pluginId: string,
  values: Record<string, unknown>,
  repoId?: string,
): Promise<void> {
  return invoke("save_plugin_top_level_configuration", {
    pluginId,
    values,
    repoId: repoId ?? null,
  });
}

export function savePluginChannelConfiguration(
  pluginId: string,
  serverName: string,
  values: Record<string, unknown>,
  repoId?: string,
): Promise<void> {
  return invoke("save_plugin_channel_configuration", {
    pluginId,
    serverName,
    values,
    repoId: repoId ?? null,
  });
}
