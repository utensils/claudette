import { invoke } from "@tauri-apps/api/core";

export function getAppSetting(key: string): Promise<string | null> {
  return invoke("get_app_setting", { key });
}

export function setAppSetting(key: string, value: string): Promise<void> {
  return invoke("set_app_setting", { key, value });
}

export function deleteAppSetting(key: string): Promise<void> {
  return invoke("delete_app_setting", { key });
}

export function listAppSettingsWithPrefix(prefix: string): Promise<[string, string][]> {
  return invoke("list_app_settings_with_prefix", { prefix });
}

export function getHostEnvFlags(): Promise<{
  disable_1m_context: boolean;
  alternative_backends_compiled: boolean;
  pi_sdk_compiled: boolean;
}> {
  return invoke("get_host_env_flags");
}
