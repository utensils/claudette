import { invoke } from "@tauri-apps/api/core";

export function listNotificationSounds(): Promise<string[]> {
  return invoke("list_notification_sounds");
}

export function playNotificationSound(
  sound: string,
  volume?: number,
): Promise<void> {
  return invoke("play_notification_sound", { sound, volume });
}

export function runNotificationCommand(
  workspaceName: string,
  workspaceId: string,
  workspacePath: string,
  rootPath: string,
  defaultBranch: string,
  branchName: string,
): Promise<void> {
  return invoke("run_notification_command", {
    workspaceName,
    workspaceId,
    workspacePath,
    rootPath,
    defaultBranch,
    branchName,
  });
}
