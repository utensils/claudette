import { invoke } from "@tauri-apps/api/core";
import type { ClaudettePluginInfo } from "../types/claudettePlugins";

/**
 * Snapshot of every discovered Claudette Lua plugin, ordered by kind
 * (SCM first, then env-provider) and then by name. Cheap — reads
 * in-memory registry state plus an app_settings scan. No plugin VMs
 * are spun up.
 */
export function listClaudettePlugins(): Promise<ClaudettePluginInfo[]> {
  return invoke("list_claudette_plugins");
}

/** Globally enable/disable a plugin. Takes effect immediately. */
export function setClaudettePluginEnabled(
  pluginName: string,
  enabled: boolean,
): Promise<void> {
  return invoke("set_claudette_plugin_enabled", { pluginName, enabled });
}

/**
 * Persist a user override for a manifest-declared setting. Pass
 * `null` to clear the override (reverts to the manifest default).
 */
export function setClaudettePluginSetting(
  pluginName: string,
  key: string,
  value: unknown,
): Promise<void> {
  return invoke("set_claudette_plugin_setting", {
    pluginName,
    key,
    value,
  });
}

/**
 * Reseed bundled plugins from the in-binary tarball, preserving any
 * user-modified `init.lua` files. Returns per-plugin warning strings
 * so the UI can surface which plugins were skipped (and why).
 */
export function reseedBundledPlugins(): Promise<string[]> {
  return invoke("reseed_bundled_plugins");
}

/** A built-in (Rust-implemented) Claudette plugin — currently just the
 *  `send_to_user` MCP tool that lets the agent deliver files inline. */
export interface BuiltinPluginInfo {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
}

/** Snapshot of every shipped built-in plugin and its enabled state. */
export function listBuiltinClaudettePlugins(): Promise<BuiltinPluginInfo[]> {
  return invoke("list_builtin_claudette_plugins");
}

/** Toggle a built-in plugin on/off. Takes effect on the next agent spawn. */
export function setBuiltinClaudettePluginEnabled(
  pluginName: string,
  enabled: boolean,
): Promise<void> {
  return invoke("set_builtin_claudette_plugin_enabled", {
    pluginName,
    enabled,
  });
}
