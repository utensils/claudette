import { invoke } from "@tauri-apps/api/core";
import type { DetectedApp } from "../../types/apps";

export function detectInstalledApps(): Promise<DetectedApp[]> {
  return invoke("detect_installed_apps");
}

export function openWorkspaceInApp(
  appId: string,
  worktreePath: string,
): Promise<void> {
  return invoke("open_workspace_in_app", {
    appId,
    worktreePath,
  });
}
