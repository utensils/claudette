import { invoke } from "@tauri-apps/api/core";
import type { ThemeDefinition } from "../../types/theme";

export function listUserThemes(): Promise<ThemeDefinition[]> {
  return invoke("list_user_themes");
}

export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}

export function openDevtools(): Promise<void> {
  return invoke("open_devtools");
}

export function getGitUsername(): Promise<string | null> {
  return invoke("get_git_username");
}

export function listSystemFonts(): Promise<string[]> {
  return invoke("list_system_fonts");
}
