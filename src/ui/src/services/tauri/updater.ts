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

export type BootStage =
  | "react_mounted"
  | "initial_data_loading"
  | "initial_data_failed";

export function reportBootStage(
  stage: BootStage,
  detail?: string,
): Promise<void> {
  return invoke("boot_stage", { stage, detail: detail ?? null });
}

export function bootOk(): Promise<void> {
  return invoke("boot_ok");
}
