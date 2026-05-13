import { invoke } from "@tauri-apps/api/core";
import type {
} from "../types";

export * from "./tauri/apps";
export * from "./tauri/localServer";
export * from "./tauri/remote";
export * from "./tauri/scm";
export * from "./tauri/plugins";
export * from "./tauri/agentBackends";
export * from "./tauri/auth";
export * from "./tauri/debug";
export * from "./tauri/files";
export * from "./tauri/diff";
export * from "./tauri/initialData";
export * from "./tauri/metrics";
export * from "./tauri/notifications";
export * from "./tauri/settings";
export * from "./tauri/pty";
export * from "./tauri/terminal";
export * from "./tauri/shell";
export * from "./tauri/updater";
export * from "./tauri/usage";
export * from "./tauri/worktrees";
export * from "./tauri/workspace";
export * from "./tauri/repository";
export * from "./tauri/plan";
export * from "./tauri/chatSessions";
export * from "./tauri/checkpoints";
export * from "./tauri/remoteControl";
export * from "./tauri/chat";
export * from "./tauri/fileMentions";
export * from "./tauri/pinnedPrompts";
export * from "./tauri/slashCommands";

// -- Sound Packs (CESP) --

import type { RegistryPack, InstalledSoundPack } from "../types/soundpacks";

export function cespFetchRegistry(): Promise<RegistryPack[]> {
  return invoke("cesp_fetch_registry");
}

export function cespListInstalled(): Promise<InstalledSoundPack[]> {
  return invoke("cesp_list_installed");
}

export function cespInstallPack(
  name: string,
  sourceRepo: string,
  sourceRef: string,
  sourcePath: string,
): Promise<InstalledSoundPack> {
  return invoke("cesp_install_pack", { name, sourceRepo, sourceRef, sourcePath });
}

export function cespUpdatePack(
  name: string,
  sourceRepo: string,
  sourceRef: string,
  sourcePath: string,
): Promise<InstalledSoundPack> {
  return invoke("cesp_update_pack", { name, sourceRepo, sourceRef, sourcePath });
}

export function cespDeletePack(name: string): Promise<void> {
  return invoke("cesp_delete_pack", { name });
}

export function cespPreviewSound(
  packName: string,
  category: string,
): Promise<void> {
  return invoke("cesp_preview_sound", { packName, category });
}
