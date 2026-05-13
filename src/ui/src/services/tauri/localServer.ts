import { invoke } from "@tauri-apps/api/core";

export interface LocalServerInfo {
  running: boolean;
  connection_string: string | null;
}

export function startLocalServer(): Promise<LocalServerInfo> {
  return invoke("start_local_server");
}

export function stopLocalServer(): Promise<void> {
  return invoke("stop_local_server");
}

export function getLocalServerStatus(): Promise<LocalServerInfo> {
  return invoke("get_local_server_status");
}
