export type PluginScope = "managed" | "user" | "project" | "local";
export type EditablePluginScope = Exclude<PluginScope, "managed">;
export type PluginSettingsTab = "available" | "installed" | "marketplaces";

export interface PluginConfigField {
  type: string;
  title: string;
  description: string;
  required: boolean;
  default: unknown | null;
  multiple: boolean;
  sensitive: boolean;
  min: number | null;
  max: number | null;
}

export interface PluginChannelSummary {
  server: string;
  display_name: string | null;
  config_schema: Record<string, PluginConfigField>;
}

export interface InstalledPlugin {
  plugin_id: string;
  name: string;
  marketplace: string | null;
  version: string;
  latest_known_version: string | null;
  update_available: boolean;
  scope: PluginScope;
  enabled: boolean;
  install_path: string;
  installed_at: string | null;
  last_updated: string | null;
  description: string | null;
  command_count: number;
  skill_count: number;
  mcp_servers: string[];
  user_config_schema: Record<string, PluginConfigField>;
  channels: PluginChannelSummary[];
}

export interface AvailablePlugin {
  plugin_id: string;
  name: string;
  marketplace: string;
  description: string | null;
  version: string | null;
  current_version: string | null;
  update_available: boolean;
  installed: boolean;
  enabled: boolean;
  installed_scopes: PluginScope[];
  enabled_scopes: PluginScope[];
  category: string | null;
  install_count: number | null;
  homepage: string | null;
  source_label: string;
}

export interface PluginCatalog {
  installed: InstalledPlugin[];
  available: AvailablePlugin[];
  updates_available: number;
}

export interface PluginMarketplace {
  name: string;
  scope: PluginScope | null;
  source_kind: string;
  source_label: string;
  install_location: string | null;
}

export interface PluginConfigState {
  values: Record<string, unknown>;
  saved_sensitive_keys: string[];
}

export interface PluginConfigSection {
  schema: Record<string, PluginConfigField>;
  state: PluginConfigState;
}

export interface PluginChannelConfiguration {
  server: string;
  display_name: string | null;
  section: PluginConfigSection;
}

export interface PluginConfiguration {
  plugin_id: string;
  top_level: PluginConfigSection | null;
  channels: PluginChannelConfiguration[];
}

export interface BulkPluginUpdateResult {
  attempted: number;
  succeeded: number;
  failed: string[];
}

export type PluginSettingsAction =
  | "install"
  | "enable"
  | "disable"
  | "uninstall"
  | "update"
  | "marketplace-add"
  | "marketplace-remove"
  | "marketplace-update";

export interface PluginSettingsIntent {
  tab: PluginSettingsTab;
  action: PluginSettingsAction | null;
  target: string | null;
  source: string | null;
  scope: EditablePluginScope;
  repoId: string | null;
}
