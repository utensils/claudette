import { invoke } from "@tauri-apps/api/core";

export type UpdateChannel = "stable" | "nightly";

export interface UpdateInfo {
  version: string;
  current_version: string;
  body: string | null;
  date: string | null;
}

export function checkForUpdatesWithChannel(
  channel: UpdateChannel,
): Promise<UpdateInfo | null> {
  return invoke("check_for_updates_with_channel", { channel });
}

export function installPendingUpdate(): Promise<void> {
  return invoke("install_pending_update");
}

export function bootOk(): Promise<void> {
  return invoke("boot_ok");
}
