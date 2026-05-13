import { invoke } from "@tauri-apps/api/core";
import type { ClaudeCodeUsage } from "../../types/usage";

export function getClaudeCodeUsage(): Promise<ClaudeCodeUsage> {
  return invoke("get_claude_code_usage");
}

export function openUsageSettings(): Promise<void> {
  return invoke("open_usage_settings");
}

export function openReleaseNotes(): Promise<void> {
  return invoke("open_release_notes");
}
